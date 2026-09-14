#include "wokwi-api.h"
#include <stdlib.h>
#include <stdint.h>
#include <stdbool.h>

#define NUM_CHANNELS 16

typedef struct {
    // Existing selector
    pin_t s0;
    pin_t s1;
    pin_t s2;
    pin_t s3;

    // Existing ultrasonic interface
    pin_t trig;
    pin_t echo;

    // New simple control bus
    pin_t ctrl_cs;
    pin_t ctrl_clk;
    pin_t ctrl_data;

    // Ultrasonic timers
    timer_t echo_start_timer;
    timer_t echo_end_timer;

    bool trig_armed;
    uint32_t echo_width_us;

    // Distance of every parking spot
    float distances[NUM_CHANNELS];

    // Control packet receiver
    uint32_t ctrl_value;
    int ctrl_bits;

} chip_state_t;


// ============================================================
//                  SELECTED SENSOR CHANNEL
// ============================================================

static int get_selected_channel(chip_state_t *chip) {

    int channel = 0;

    channel |= pin_read(chip->s0) << 0;
    channel |= pin_read(chip->s1) << 1;
    channel |= pin_read(chip->s2) << 2;
    channel |= pin_read(chip->s3) << 3;

    return channel;
}


// ============================================================
//                     ECHO GENERATION
// ============================================================

static void echo_end_callback(void *user_data) {

    chip_state_t *chip = user_data;

    pin_write(chip->echo, LOW);
}


static void echo_start_callback(void *user_data) {

    chip_state_t *chip = user_data;

    pin_write(chip->echo, HIGH);

    timer_start(
        chip->echo_end_timer,
        chip->echo_width_us,
        false
    );
}


// ============================================================
//                       TRIG INPUT
// ============================================================

static void trig_changed(
    void *user_data,
    pin_t pin,
    uint32_t value
) {

    chip_state_t *chip = user_data;

    // TRIG went HIGH
    if (value == HIGH) {
        chip->trig_armed = true;
        return;
    }

    // Ignore LOW transitions that weren't preceded by HIGH
    if (!chip->trig_armed) {
        return;
    }

    chip->trig_armed = false;

    // Read S0-S3
    int channel = get_selected_channel(chip);

    if (channel < 0 || channel >= NUM_CHANNELS) {
        return;
    }

    float distance = chip->distances[channel];

    // HC-SR04 formula:
    // echo pulse width ~= distance(cm) * 58us
    chip->echo_width_us =
        (uint32_t)(distance * 58.0f);

    // Keep the existing 300us delay
    timer_start(
        chip->echo_start_timer,
        300,
        false
    );
}


// ============================================================
//                 CONTROL BUS - CHIP SELECT
// ============================================================

static void ctrl_cs_changed(
    void *user_data,
    pin_t pin,
    uint32_t value
) {

    chip_state_t *chip = user_data;

    // New packet starts when CS goes LOW
    if (value == LOW) {

        chip->ctrl_value = 0;
        chip->ctrl_bits = 0;
    }
}


// ============================================================
//                 CONTROL BUS - CLOCK
// ============================================================

static void ctrl_clock_changed(
    void *user_data,
    pin_t pin,
    uint32_t value
) {

    chip_state_t *chip = user_data;

    // We only registered RISING edges,
    // but keep this defensive check.
    if (value != HIGH) {
        return;
    }

    // Ignore clock when chip isn't selected
    if (pin_read(chip->ctrl_cs) != LOW) {
        return;
    }

    // Shift previous bits left
    chip->ctrl_value <<= 1;

    // Read current DATA bit
    if (pin_read(chip->ctrl_data) == HIGH) {
        chip->ctrl_value |= 1;
    }

    chip->ctrl_bits++;


    // Complete packet:
    //
    // bits 23..16 = channel
    // bits 15..0  = distance * 100
    //
    // Example:
    // channel = 4
    // distance = 25.00cm
    //
    // packet = 0x04 09 C4
    //
    if (chip->ctrl_bits == 24) {

        uint8_t channel =
            (chip->ctrl_value >> 16) & 0xFF;

        uint16_t distance_x100 =
            chip->ctrl_value & 0xFFFF;

        if (channel < NUM_CHANNELS) {

            chip->distances[channel] =
                distance_x100 / 100.0f;
        }

        chip->ctrl_value = 0;
        chip->ctrl_bits = 0;
    }
}


// ============================================================
//                         INIT
// ============================================================

void chip_init() {

    chip_state_t *chip =
        calloc(1, sizeof(chip_state_t));


    // --------------------------------------------------------
    // Default every parking spot to 200cm
    // --------------------------------------------------------

    for (int i = 0; i < NUM_CHANNELS; i++) {
        chip->distances[i] = 200.0f;
    }


    // --------------------------------------------------------
    // S0-S3
    // --------------------------------------------------------

    chip->s0 = pin_init("S0", INPUT);
    chip->s1 = pin_init("S1", INPUT);
    chip->s2 = pin_init("S2", INPUT);
    chip->s3 = pin_init("S3", INPUT);


    // --------------------------------------------------------
    // TRIG / ECHO
    // --------------------------------------------------------

    chip->trig =
        pin_init("TRIG", INPUT);

    chip->echo =
        pin_init("ECHO", OUTPUT_LOW);


    // --------------------------------------------------------
    // Control bus
    // --------------------------------------------------------

    chip->ctrl_cs =
        pin_init("CTRL_CS", INPUT);

    chip->ctrl_clk =
        pin_init("CTRL_CLK", INPUT);

    chip->ctrl_data =
        pin_init("CTRL_DATA", INPUT);


    // --------------------------------------------------------
    // ECHO timers
    // --------------------------------------------------------

    timer_config_t echo_start_config = {
        .callback = echo_start_callback,
        .user_data = chip
    };

    chip->echo_start_timer =
        timer_init(&echo_start_config);


    timer_config_t echo_end_config = {
        .callback = echo_end_callback,
        .user_data = chip
    };

    chip->echo_end_timer =
        timer_init(&echo_end_config);


    // --------------------------------------------------------
    // Watch TRIG
    // --------------------------------------------------------

    pin_watch_config_t trig_watch = {
        .edge = BOTH,
        .pin_change = trig_changed,
        .user_data = chip
    };

    pin_watch(
        chip->trig,
        &trig_watch
    );


    // --------------------------------------------------------
    // Watch control CS
    // --------------------------------------------------------

    pin_watch_config_t cs_watch = {
        .edge = BOTH,
        .pin_change = ctrl_cs_changed,
        .user_data = chip
    };

    pin_watch(
        chip->ctrl_cs,
        &cs_watch
    );


    // --------------------------------------------------------
    // Watch control CLOCK
    // --------------------------------------------------------

    pin_watch_config_t clock_watch = {
        .edge = RISING,
        .pin_change = ctrl_clock_changed,
        .user_data = chip
    };

    pin_watch(
        chip->ctrl_clk,
        &clock_watch
    );
}