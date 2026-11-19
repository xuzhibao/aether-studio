#include "fwval_core.h"

#include <string.h>

uint32_t fwval_fnv1a32(const char *data, size_t len) {
    uint32_t hash = 2166136261u;
    for (size_t i = 0; i < len; i++) {
        hash ^= (uint8_t)data[i];
        hash *= 16777619u;
    }
    return hash;
}

uint32_t fwval_answer(const char *token, const char *fwid) {
    uint32_t x = fwval_fnv1a32(token, strlen(token)) ^ fwval_fnv1a32(fwid, strlen(fwid));
    x ^= x >> 16;
    x *= 0x7feb352du;
    x ^= x >> 15;
    x *= 0x846ca68bu;
    x ^= x >> 16;
    return x;
}

void fwval_answer_hex(uint32_t value, char out[9]) {
    static const char digits[] = "0123456789abcdef";
    for (int i = 7; i >= 0; i--) {
        out[i] = digits[value & 0xfu];
        value >>= 4;
    }
    out[8] = '\0';
}

bool fwval_token_valid(const char *token) {
    if (token == NULL) {
        return false;
    }
    for (size_t i = 0; i < FWVAL_TOKEN_LEN; i++) {
        char c = token[i];
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) {
            return false;
        }
    }
    return token[FWVAL_TOKEN_LEN] == '\0';
}

void fwval_line_reset(fwval_line_t *line) {
    line->len = 0;
    line->invalid = false;
    line->text[0] = '\0';
}

fwval_line_status fwval_line_feed(fwval_line_t *line, uint8_t byte) {
    if (byte == '\n') {
        if (line->len > 0 && line->text[line->len - 1] == '\r') {
            line->len--;
        }
        line->text[line->len] = '\0';
        return FWVAL_LINE_COMPLETE;
    }
    if ((byte < 0x20 || byte > 0x7e) && byte != '\r') {
        line->invalid = true;
    }
    if (line->len >= FWVAL_MAX_LINE) {
        fwval_line_reset(line);
        return FWVAL_LINE_OVERFLOW;
    }
    line->text[line->len++] = (char)byte;
    line->text[line->len] = '\0';
    return FWVAL_LINE_NONE;
}

bool fwval_line_is_ascii(const fwval_line_t *line) {
    return !line->invalid;
}
