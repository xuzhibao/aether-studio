/* Aether firmware-validation example (ESP32-C3).
 *
 * Same application image, two real transports:
 *   - UART0 console: always active. This is the transport QEMU exposes.
 *   - Native USB-Serial/JTAG: started best-effort after UART0 is up. It is an
 *     independent, non-blocking side channel; if the peripheral is missing
 *     (QEMU) or its driver fails, UART0 keeps working and the app keeps running.
 *
 * Protocol (line oriented, printable ASCII, max 128 bytes):
 *   boot    -> AETHER-VAL/1 READY fw=<fwid> proto=1 soc=esp32c3 console=uart0
 *   host    -> CHALLENGE token=<16 lowercase hex>
 *   device  -> AETHER-VAL/1 RESPONSE token=<token> value=<8 hex> fw=<fwid>
 *   device  -> AETHER-VAL/1 ERROR code=<bad-command|bad-token|line-too-long>
 *
 * The challenge answer is computed in RAM only. Nothing here touches NVS, the
 * partition table, GPIO, the flash write path or the network. */
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#include "driver/usb_serial_jtag.h"
#include "esp_err.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "fwval_core.h"

static const char *TAG = "fwval";

typedef enum { SRC_UART0 = 0, SRC_USB = 1, SRC_COUNT = 2 } src_id_t;

typedef struct {
    fwval_line_t line;
    bool ready;
} source_t;

static source_t s_sources[SRC_COUNT];

static void source_write(src_id_t src, const char *text) {
    size_t len = strlen(text);
    if (src == SRC_UART0) {
        fwrite(text, 1, len, stdout);
        fflush(stdout);
        return;
    }
    size_t offset = 0;
    while (offset < len) {
        int n = usb_serial_jtag_write_bytes(text + offset, len - offset, pdMS_TO_TICKS(20));
        if (n <= 0) {
            break; /* Host not reading; never stall the protocol loop. */
        }
        offset += (size_t)n;
    }
}

static void send_ready(src_id_t src) {
    if (src == SRC_USB && !s_sources[SRC_USB].ready) {
        return;
    }
    char line[128];
    snprintf(line, sizeof(line), "%s READY fw=%s proto=1 soc=esp32c3 console=%s\n",
             FWVAL_PROTO_PREFIX, FWVAL_FWID, src == SRC_UART0 ? "uart0" : "usb-serial-jtag");
    source_write(src, line);
}

static void send_error(src_id_t src, const char *code) {
    char line[96];
    snprintf(line, sizeof(line), "%s ERROR code=%s\n", FWVAL_PROTO_PREFIX, code);
    source_write(src, line);
}

/* Extracts the token from "CHALLENGE token=<16 hex>". Returns NULL when the
 * command shape is wrong. */
static const char *parse_challenge(const char *line) {
    static const char prefix[] = "CHALLENGE token=";
    size_t prefix_len = sizeof(prefix) - 1;
    if (strncmp(line, prefix, prefix_len) != 0) {
        return NULL;
    }
    const char *token = line + prefix_len;
    if (!fwval_token_valid(token)) {
        return NULL;
    }
    return token;
}

static void handle_line(src_id_t src, fwval_line_t *line) {
    if (line->len == 0) {
        return;
    }
    if (!fwval_line_is_ascii(line)) {
        send_error(src, "bad-command");
        return;
    }
    /* A host that attaches after boot asks for the identity explicitly; the reply is the
     * same READY line, so a challenge never depends on having caught the boot line. */
    if (strcmp(line->text, "HELLO") == 0) {
        send_ready(src);
        return;
    }
    const char *token = parse_challenge(line->text);
    if (token == NULL) {
        send_error(src, "bad-command");
        return;
    }
    char answer[9];
    fwval_answer_hex(fwval_answer(token, FWVAL_FWID), answer);
    char out[128];
    snprintf(out, sizeof(out), "%s RESPONSE token=%s value=%s fw=%s\n",
             FWVAL_PROTO_PREFIX, token, answer, FWVAL_FWID);
    source_write(src, out);
}

static void start_usb_channel(void) {
    usb_serial_jtag_driver_config_t cfg = {
        .rx_buffer_size = 512,
        .tx_buffer_size = 512,
    };
    esp_err_t err = usb_serial_jtag_driver_install(&cfg);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "USB-Serial/JTAG driver unavailable: %s", esp_err_to_name(err));
        return;
    }
    s_sources[SRC_USB].ready = true;
    ESP_LOGI(TAG, "USB-Serial/JTAG channel started");
    send_ready(SRC_USB);
}

static void service_source(src_id_t src, const char *bytes, int count) {
    for (int i = 0; i < count; i++) {
        fwval_line_t *line = &s_sources[src].line;
        fwval_line_status status = fwval_line_feed(line, (uint8_t)bytes[i]);
        if (status == FWVAL_LINE_COMPLETE) {
            handle_line(src, line);
            fwval_line_reset(line);
        } else if (status == FWVAL_LINE_OVERFLOW) {
            send_error(src, "line-too-long");
        }
    }
}

void app_main(void) {
    fcntl(STDIN_FILENO, F_SETFL, fcntl(STDIN_FILENO, F_GETFL, 0) | O_NONBLOCK);
    for (int i = 0; i < SRC_COUNT; i++) {
        fwval_line_reset(&s_sources[i].line);
    }
    s_sources[SRC_UART0].ready = true;
    send_ready(SRC_UART0);
    start_usb_channel();

    // A host may attach after boot (for example the product opens the port after flashing).
    // Emit READY again on a USB connection transition so the challenge does not require a
    // manual reset; the app still sends exactly one READY per attachment.
    bool usb_connected = false;
    char byte;
    for (;;) {
        bool idle = true;
        if (s_sources[SRC_USB].ready) {
            bool connected = usb_serial_jtag_is_connected();
            if (connected && !usb_connected) {
                send_ready(SRC_USB);
            }
            usb_connected = connected;
        }
        int n = read(STDIN_FILENO, &byte, 1);
        if (n == 1) {
            service_source(SRC_UART0, &byte, 1);
            idle = false;
        }
        if (s_sources[SRC_USB].ready) {
            int m = usb_serial_jtag_read_bytes(&byte, 1, 0);
            if (m == 1) {
                service_source(SRC_USB, &byte, 1);
                idle = false;
            }
        }
        if (idle) {
            vTaskDelay(pdMS_TO_TICKS(2));
        }
    }
}
