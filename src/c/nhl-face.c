#include <pebble.h>

#define PERSIST_KEY_DATA 1
#define DATA_VERSION 1

enum { STATE_NONE = 0, STATE_NEXT = 1, STATE_LIVE = 2, STATE_FINAL = 3 };

// Everything the phone sends us; persisted so the face draws instantly on launch.
typedef struct {
  uint8_t version;
  char team_name[20];
  int32_t primary;
  int32_t secondary;
  int32_t text;
  int32_t text2;
  char record[24];
  char rank[24];
  int32_t game_state;
  int32_t game_start;
  char opp[6];
  int32_t home;
  char line1[24];
  char line2[32];
  int32_t refresh_mins;
} FaceData;

static Window *s_window;
static Layer *s_canvas;
static FaceData s_data;
static int s_refresh_countdown;
static char s_time_buf[8];
static char s_date_buf[16];
static char s_next1_buf[24];
static char s_next2_buf[32];

static GColor prv_color(int32_t hex, GColor bw) {
  return PBL_IF_COLOR_ELSE(GColorFromHEX(hex), bw);
}

static void prv_upcase(char *s) {
  for (; *s; s++) {
    if (*s >= 'a' && *s <= 'z') *s -= 'a' - 'A';
  }
}

static void prv_request_update(void) {
  DictionaryIterator *iter;
  if (app_message_outbox_begin(&iter) != APP_MSG_OK) return;
  dict_write_uint8(iter, MESSAGE_KEY_RequestUpdate, 1);
  app_message_outbox_send();
}

static void prv_reset_countdown(void) {
  s_refresh_countdown = s_data.refresh_mins > 0 ? s_data.refresh_mins : 30;
}

static void prv_load_data(void) {
  if (persist_exists(PERSIST_KEY_DATA)) {
    persist_read_data(PERSIST_KEY_DATA, &s_data, sizeof(s_data));
  }
  if (s_data.version != DATA_VERSION) {
    memset(&s_data, 0, sizeof(s_data));
    s_data.version = DATA_VERSION;
    s_data.primary = 0x000000;
    s_data.secondary = 0xFFFFFF;
    s_data.text = 0xFFFFFF;
    s_data.text2 = 0x000000;
    strncpy(s_data.team_name, "NHL", sizeof(s_data.team_name));
    strncpy(s_data.line1, "LOADING...", sizeof(s_data.line1));
  }
}

// Formats an upcoming game, e.g. "NEXT  vs CHI" / "TODAY 7:00 PM".
static void prv_format_next(void) {
  snprintf(s_next1_buf, sizeof(s_next1_buf), "NEXT  %s %s",
           s_data.home ? "vs" : "@", s_data.opp);

  time_t start = s_data.game_start;
  struct tm *t = localtime(&start);
  char clock_buf[12];
  if (clock_is_24h_style()) {
    strftime(clock_buf, sizeof(clock_buf), "%H:%M", t);
  } else {
    strftime(clock_buf, sizeof(clock_buf), "%l:%M %p", t);
  }
  const char *clock_str = clock_buf[0] == ' ' ? clock_buf + 1 : clock_buf;

  int days = (int)((start - time_start_of_today()) / SECONDS_PER_DAY);
  char day_buf[12];
  if (start < time_start_of_today() || days == 0) {
    strncpy(day_buf, "TODAY", sizeof(day_buf));
  } else if (days == 1) {
    strncpy(day_buf, "TMRW", sizeof(day_buf));
  } else if (days < 7) {
    strftime(day_buf, sizeof(day_buf), "%a", t);
  } else {
    strftime(day_buf, sizeof(day_buf), "%a %m/%d", t);
  }
  snprintf(s_next2_buf, sizeof(s_next2_buf), "%s %s", day_buf, clock_str);
  prv_upcase(s_next2_buf);
}

static void prv_draw_text(GContext *ctx, const char *text, const char *font_key,
                          GRect rect, GColor color) {
  graphics_context_set_text_color(ctx, color);
  graphics_draw_text(ctx, text, fonts_get_system_font(font_key), rect,
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
}

static void prv_canvas_update(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);
  const int w = b.size.w;
  const bool big = b.size.h >= 200;

  const GColor bg = prv_color(s_data.primary, GColorBlack);
  const GColor accent = prv_color(s_data.secondary, GColorWhite);
  const GColor fg = prv_color(s_data.text, GColorWhite);
  const GColor fg2 = prv_color(s_data.text2, GColorBlack);

  const int banner_h = big ? 32 : 24;
  const int time_y = big ? 30 : 20;
  const int date_y = big ? 82 : 60;
  const int box_y = big ? 110 : 84;
  const int box_h = big ? 62 : 48;
  const int record_y = big ? 174 : 132;
  const int rank_y = big ? 198 : 148;

  const char *banner_font = big ? FONT_KEY_GOTHIC_24_BOLD : FONT_KEY_GOTHIC_18_BOLD;
  const char *time_font = big ? FONT_KEY_LECO_42_NUMBERS : FONT_KEY_LECO_36_BOLD_NUMBERS;
  const char *line1_font = big ? FONT_KEY_GOTHIC_18_BOLD : FONT_KEY_GOTHIC_14_BOLD;
  const char *line2_font = big ? FONT_KEY_GOTHIC_24_BOLD : FONT_KEY_GOTHIC_18_BOLD;
  const char *record_font = big ? FONT_KEY_GOTHIC_18_BOLD : FONT_KEY_GOTHIC_14_BOLD;
  const char *rank_font = big ? FONT_KEY_GOTHIC_18 : FONT_KEY_GOTHIC_14;

  graphics_context_set_fill_color(ctx, bg);
  graphics_fill_rect(ctx, b, 0, GCornerNone);

  // Team name banner
  graphics_context_set_fill_color(ctx, accent);
  graphics_fill_rect(ctx, GRect(0, 0, w, banner_h), 0, GCornerNone);
  prv_draw_text(ctx, s_data.team_name, banner_font,
                GRect(2, big ? -2 : -1, w - 4, banner_h), fg2);

  // Time and date
  prv_draw_text(ctx, s_time_buf, time_font, GRect(0, time_y, w, 50), fg);
  prv_draw_text(ctx, s_date_buf, big ? FONT_KEY_GOTHIC_18 : FONT_KEY_GOTHIC_14,
                GRect(0, date_y, w, 22), fg);

  // Game box: live score, final score, or next game
  const char *line1 = s_data.line1;
  const char *line2 = s_data.line2;
  if (s_data.game_state == STATE_NEXT) {
    prv_format_next();
    line1 = s_next1_buf;
    line2 = s_next2_buf;
  } else if (s_data.game_state == STATE_NONE && s_data.team_name[0] && s_data.record[0]) {
    line1 = "NO GAMES";
    line2 = "SCHEDULED";
  }
  GRect box = GRect(6, box_y, w - 12, box_h);
  graphics_context_set_fill_color(ctx, accent);
  graphics_fill_rect(ctx, box, 6, GCornersAll);
  prv_draw_text(ctx, line1, line1_font, GRect(box.origin.x + 2, box_y + 1, box.size.w - 4, 22), fg2);
  prv_draw_text(ctx, line2, line2_font,
                GRect(box.origin.x + 2, box_y + (big ? 22 : 16), box.size.w - 4, 30), fg2);

  // Record and league rank
  prv_draw_text(ctx, s_data.record, record_font, GRect(0, record_y, w, 22), fg);
  prv_draw_text(ctx, s_data.rank, rank_font, GRect(0, rank_y, w, 22), fg);
}

static void prv_update_time(void) {
  time_t now = time(NULL);
  struct tm *t = localtime(&now);
  strftime(s_time_buf, sizeof(s_time_buf), clock_is_24h_style() ? "%H:%M" : "%I:%M", t);
  if (!clock_is_24h_style() && s_time_buf[0] == '0') {
    memmove(s_time_buf, s_time_buf + 1, strlen(s_time_buf));
  }
  strftime(s_date_buf, sizeof(s_date_buf), "%a %b %e", t);
  prv_upcase(s_date_buf);
  layer_mark_dirty(s_canvas);
}

static void prv_tick_handler(struct tm *tick_time, TimeUnits units_changed) {
  prv_update_time();
  if (--s_refresh_countdown <= 0) {
    prv_reset_countdown();
    prv_request_update();
  }
}

static void prv_copy_string(char *dest, size_t size, Tuple *t) {
  if (t) {
    strncpy(dest, t->value->cstring, size - 1);
    dest[size - 1] = '\0';
  }
}

static void prv_copy_int(int32_t *dest, Tuple *t) {
  if (t) *dest = t->value->int32;
}

static void prv_inbox_received(DictionaryIterator *iter, void *context) {
  prv_copy_string(s_data.team_name, sizeof(s_data.team_name), dict_find(iter, MESSAGE_KEY_TeamName));
  prv_copy_int(&s_data.primary, dict_find(iter, MESSAGE_KEY_ColorPrimary));
  prv_copy_int(&s_data.secondary, dict_find(iter, MESSAGE_KEY_ColorSecondary));
  prv_copy_int(&s_data.text, dict_find(iter, MESSAGE_KEY_ColorText));
  prv_copy_int(&s_data.text2, dict_find(iter, MESSAGE_KEY_ColorText2));
  prv_copy_string(s_data.record, sizeof(s_data.record), dict_find(iter, MESSAGE_KEY_Record));
  prv_copy_string(s_data.rank, sizeof(s_data.rank), dict_find(iter, MESSAGE_KEY_Rank));
  prv_copy_int(&s_data.refresh_mins, dict_find(iter, MESSAGE_KEY_RefreshMins));

  Tuple *state = dict_find(iter, MESSAGE_KEY_GameState);
  if (state) {
    s_data.game_state = state->value->int32;
    s_data.line1[0] = '\0';
    s_data.line2[0] = '\0';
    prv_copy_int(&s_data.game_start, dict_find(iter, MESSAGE_KEY_GameStart));
    prv_copy_string(s_data.opp, sizeof(s_data.opp), dict_find(iter, MESSAGE_KEY_GameOpp));
    prv_copy_int(&s_data.home, dict_find(iter, MESSAGE_KEY_GameHome));
    prv_copy_string(s_data.line1, sizeof(s_data.line1), dict_find(iter, MESSAGE_KEY_GameLine1));
    prv_copy_string(s_data.line2, sizeof(s_data.line2), dict_find(iter, MESSAGE_KEY_GameLine2));
  }

  persist_write_data(PERSIST_KEY_DATA, &s_data, sizeof(s_data));
  prv_reset_countdown();
  layer_mark_dirty(s_canvas);
}

static void prv_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  s_canvas = layer_create(layer_get_bounds(root));
  layer_set_update_proc(s_canvas, prv_canvas_update);
  layer_add_child(root, s_canvas);
  prv_update_time();
}

static void prv_window_unload(Window *window) {
  layer_destroy(s_canvas);
}

static void prv_init(void) {
  prv_load_data();
  prv_reset_countdown();

  s_window = window_create();
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = prv_window_load,
    .unload = prv_window_unload,
  });
  window_stack_push(s_window, true);

  tick_timer_service_subscribe(MINUTE_UNIT, prv_tick_handler);
  app_message_register_inbox_received(prv_inbox_received);
  app_message_open(512, 64);
}

static void prv_deinit(void) {
  tick_timer_service_unsubscribe();
  window_destroy(s_window);
}

int main(void) {
  prv_init();
  app_event_loop();
  prv_deinit();
}
