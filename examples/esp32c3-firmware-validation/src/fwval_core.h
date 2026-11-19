/* Protocol core for the ESP32-C3 firmware-validation example.
 *
 * Deliberately free of ESP-IDF, Arduino and libc I/O so the same rules can be
 * compiled and diff-tested on a host. All arithmetic is 32-bit unsigned. */
#ifndef FWVAL_CORE_H
#define FWVAL_CORE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define FWVAL_PROTO_PREFIX "AETHER-VAL/1"
#define FWVAL_FWID "aether-c3-fwval-1"
#define FWVAL_TOKEN_LEN 16
#define FWVAL_MAX_LINE 128

/* FNV-1a 32-bit over exactly `len` bytes. */
uint32_t fwval_fnv1a32(const char *data, size_t len);

/* Deterministic 32-bit challenge answer: FNV-1a(token) mixed with FNV-1a(fwid). */
uint32_t fwval_answer(const char *token, const char *fwid);

/* 8 lowercase hex characters plus NUL. */
void fwval_answer_hex(uint32_t value, char out[9]);

/* Exactly FWVAL_TOKEN_LEN characters, all [0-9a-f]. */
bool fwval_token_valid(const char *token);

typedef enum {
    FWVAL_LINE_NONE = 0,
    FWVAL_LINE_COMPLETE,
    FWVAL_LINE_OVERFLOW,
} fwval_line_status;

typedef struct {
    char text[FWVAL_MAX_LINE + 1];
    size_t len;
    bool invalid;
} fwval_line_t;

void fwval_line_reset(fwval_line_t *line);

/* Feed one byte. Returns COMPLETE on LF (CR trimmed), OVERFLOW when the line
 * exceeds FWVAL_MAX_LINE; both reset the buffer for the next line. */
fwval_line_status fwval_line_feed(fwval_line_t *line, uint8_t byte);

/* True when every byte of the completed line is printable ASCII (0x20..0x7e). */
bool fwval_line_is_ascii(const fwval_line_t *line);

#endif
