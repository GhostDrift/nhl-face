#include <pebble.h>
#include "logos.h"

#define PERSIST_KEY_DATA 1
#define PERSIST_KEY_VIBE 2
#define DATA_VERSION 6

enum { STATE_NONE = 0, STATE_NEXT = 1, STATE_LIVE = 2, STATE_FINAL = 3 };
enum { BUZZ_PERIOD = 1, BUZZ_FINAL = 2 };
enum { GOAL_MINE = 1, GOAL_OPP = 2 };

// Everything the phone sends us; persisted so the face draws instantly on launch.
typedef struct {
  uint8_t version;
  char team_name[20];
  char team_abbrev[4];
  int32_t primary;
  int32_t secondary;
  int32_t tertiary;
  int32_t text;
  int32_t text2;
  int32_t label;
  char record[16];
  char points[6];
  char div_name[6];
  char div_rank[6];
  char league_rank[6];
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
static bool s_quiet_time;
static bool s_bt_connected = true;
static bool s_vibe_on_disconnect;
static char s_next1_buf[24];
static char s_next2_buf[32];

// How long the goal banner covers the NHL block, unless the phone says otherwise.
#define GOAL_BANNER_SECS 30

// The team's latest goal, shown in a banner over the NHL block while s_banner_timer runs.
static AppTimer *s_banner_timer;
static char s_goal_scorer[32];
static char s_goal_assists[64];
static char s_goal_time[24];
static char s_goal_score[24];
// The team's logo, shown faintly behind the goal banner. Color watches only.
static GBitmap *s_logo;
// How long a wrist flick swaps the NHL block between the logo and the game and standings.
#define FLICK_SECS 10
// Runs while a wrist flick has the NHL block swapped.
static AppTimer *s_flick_timer;
// The team's logo in color, loaded while the NHL block shows it, and its resource.
static GBitmap *s_color_logo;
static uint32_t s_color_logo_res;
#ifdef PREVIEW
// Preview build: which team color scheme is up, shown in the date tab.
static char s_preview_label[24];
#endif

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
    s_data.tertiary = 0x000000;
    strncpy(s_data.team_name, "NHL", sizeof(s_data.team_name));
    s_data.text = 0xFFFFFF;
    s_data.text2 = 0x000000;
    s_data.label = 0x000000;
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

// A system font plus where its capitals sit inside a text box drawn at y.
typedef struct {
  const char *key;
  int cap_top;
  int cap_h;
} Font;

static const Font FONT_14_BOLD = { FONT_KEY_GOTHIC_14_BOLD, 5, 9 };
static const Font FONT_18_BOLD = { FONT_KEY_GOTHIC_18_BOLD, 7, 11 };
static const Font FONT_24_BOLD = { FONT_KEY_GOTHIC_24_BOLD, 10, 15 };
static const Font FONT_TIME_SMALL = { FONT_KEY_LECO_36_BOLD_NUMBERS, 11, 25 };
static const Font FONT_TIME_BIG = { FONT_KEY_LECO_42_NUMBERS, 13, 30 };

// Draws text with its capitals starting at cap_y.
static void prv_draw_caps(GContext *ctx, const char *text, Font font, int x, int cap_y, int w, GColor color) {
  prv_draw_text(ctx, text, font.key, GRect(x, cap_y - font.cap_top, w, font.cap_h + font.cap_top + 8), color);
}

// Sets a label into a horizontal pinstripe at stripe_y, breaking the stripe around it.
// With tab set, the label sits on a small tab of the gap color instead.
static void prv_draw_stripe_label(GContext *ctx, const char *text, Font font, int x, int stripe_y, int w,
                                  bool tab, GColor gap, GColor color) {
  GRect rect = GRect(x + 4, stripe_y - font.cap_top - font.cap_h / 2, w - 8, font.cap_h + font.cap_top + 8);
  GSize size = graphics_text_layout_get_content_size(text, fonts_get_system_font(font.key), rect,
                                                     GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter);
  const int gap_w = size.w + 6;
  graphics_context_set_fill_color(ctx, gap);
  if (tab) {
    graphics_fill_rect(ctx, GRect(x + (w - gap_w) / 2, stripe_y - font.cap_h / 2 - 1, gap_w, font.cap_h + 2),
                       3, GCornersAll);
  } else {
    graphics_fill_rect(ctx, GRect(x + (w - gap_w) / 2, stripe_y - 1, gap_w, 3), 0, GCornerNone);
  }
  prv_draw_text(ctx, text, font.key, rect, color);
}

// How far a bubble's pinstripe sits inside its edge.
#define BUBBLE_STRIPE_INSET 2

// A filled bubble with a pinstripe just inside its edge, a label tab in the top
// stripe, and a value inside.
static void prv_draw_bubble(GContext *ctx, GRect rect, const char *label, Font label_font, const char *value,
                            Font value_font, GColor fill, GColor stripe, GColor label_fg, GColor fg) {
  GRect in = grect_inset(rect, GEdgeInsets(BUBBLE_STRIPE_INSET));
  graphics_context_set_fill_color(ctx, fill);
  graphics_fill_rect(ctx, rect, 5, GCornersAll);
  graphics_context_set_stroke_color(ctx, stripe);
  graphics_draw_round_rect(ctx, in, 3);
  prv_draw_stripe_label(ctx, label, label_font, in.origin.x, in.origin.y, in.size.w, true, fill, label_fg);
  const int below_label = in.origin.y + (label_font.cap_h + 1) / 2;
  const int bottom = in.origin.y + in.size.h - 1;
  prv_draw_caps(ctx, value, value_font, in.origin.x, (below_label + bottom - value_font.cap_h + 1) / 2,
                in.size.w, fg);
}

// Status badges sit on small tabs set into a pinstripe. A badge of radius r
// fills a tab this wide.
#define BADGE_TAB_W(r) (2 * (r) + 8)

static void prv_draw_badge_tab(GContext *ctx, GPoint center, int r, GColor tab) {
  graphics_context_set_fill_color(ctx, tab);
  graphics_fill_rect(ctx, GRect(center.x - r - 4, center.y - r - 1, BADGE_TAB_W(r), 2 * r + 3), 3, GCornersAll);
}

// A crescent moon on a tab, to show Quiet Time is on.
static void prv_draw_quiet_tab(GContext *ctx, GPoint center, int r, GColor tab, GColor fg) {
  prv_draw_badge_tab(ctx, center, r, tab);
  graphics_context_set_fill_color(ctx, fg);
  graphics_fill_circle(ctx, center, r);
  // Carve the crescent with a slightly smaller circle, offset so it stays inside
  // the tab: its top reaches the tab's top edge (r + 1 above center) and no further.
  graphics_context_set_fill_color(ctx, tab);
  graphics_fill_circle(ctx, GPoint(center.x + r / 2, center.y - 2), r - 1);
}

// A Bluetooth rune struck through with a slash, on a tab, to show the phone is
// disconnected.
static void prv_draw_bt_off_tab(GContext *ctx, GPoint center, int r, GColor tab, GColor fg) {
  prv_draw_badge_tab(ctx, center, r, tab);
  const int x = center.x, y = center.y, h = r / 2;
  graphics_context_set_stroke_color(ctx, fg);
  graphics_context_set_stroke_width(ctx, 1);
  graphics_draw_line(ctx, GPoint(x - h, y + h), GPoint(x + h, y - h));
  graphics_draw_line(ctx, GPoint(x + h, y - h), GPoint(x, y - r));
  graphics_draw_line(ctx, GPoint(x, y - r), GPoint(x, y + r));
  graphics_draw_line(ctx, GPoint(x, y + r), GPoint(x + h, y + h));
  graphics_draw_line(ctx, GPoint(x + h, y + h), GPoint(x - h, y - h));
  graphics_draw_line(ctx, GPoint(x - r, y - r), GPoint(x + r, y + r));
}

// A block with a border band in one color around a panel in another, and a
// pinstripe running inside the band, inset pixels in from the edge and band
// pixels out from the panel.
static void prv_draw_block(GContext *ctx, GRect rect, int inset, int band, GColor border, GColor panel,
                           GColor stripe) {
  GRect line = grect_inset(rect, GEdgeInsets(inset));
  graphics_context_set_fill_color(ctx, border);
  graphics_fill_rect(ctx, rect, 8, GCornersAll);
  graphics_context_set_fill_color(ctx, panel);
  graphics_fill_rect(ctx, grect_inset(line, GEdgeInsets(band)), 3, GCornersAll);
  graphics_context_set_stroke_color(ctx, stripe);
  graphics_context_set_stroke_width(ctx, 1);
  graphics_draw_round_rect(ctx, line, 5);
}

// A color one step from a toward b in each channel where they differ: the
// faintest visible tint of a toward b.
static GColor prv_tint(GColor a, GColor b) {
  GColor c = a;
  c.r += (b.r > a.r) - (b.r < a.r);
  c.g += (b.g > a.g) - (b.g < a.g);
  c.b += (b.b > a.b) - (b.b < a.b);
  return c;
}

static void prv_load_logo(void) {
#ifdef PBL_COLOR
  if (s_logo) return;
  for (unsigned i = 0; i < ARRAY_LENGTH(LOGOS); i++) {
    if (strcmp(LOGOS[i].abbr, s_data.team_abbrev) == 0) {
      s_logo = gbitmap_create_with_resource(LOGOS[i].faded);
      return;
    }
  }
#endif
}

static void prv_unload_logo(void) {
  if (s_logo) gbitmap_destroy(s_logo);
  s_logo = NULL;
}

static void prv_unload_color_logo(void) {
  if (s_color_logo) gbitmap_destroy(s_color_logo);
  s_color_logo = NULL;
  s_color_logo_res = 0;
}

// Loads the color logo for the current team and panel, the NHL's version for dark
// backgrounds if the panel is dark, replacing one loaded for another team or panel.
static void prv_load_color_logo(void) {
#ifdef PBL_COLOR
  const GColor panel = prv_color(s_data.primary, GColorBlack);
  const bool dark = panel.r * 299 + panel.g * 587 + panel.b * 114 < 1500;
  for (unsigned i = 0; i < ARRAY_LENGTH(LOGOS); i++) {
    if (strcmp(LOGOS[i].abbr, s_data.team_abbrev) == 0) {
      const uint32_t res = dark && LOGOS[i].color_dark ? LOGOS[i].color_dark : LOGOS[i].color;
      if (res == s_color_logo_res) return;
      prv_unload_color_logo();
      s_color_logo = gbitmap_create_with_resource(res);
      if (s_color_logo) s_color_logo_res = res;
      return;
    }
  }
#endif
}

static void prv_draw_centered(GContext *ctx, GBitmap *bitmap, GRect rect) {
  GSize size = gbitmap_get_bounds(bitmap).size;
  graphics_context_set_compositing_mode(ctx, GCompOpSet);
  graphics_draw_bitmap_in_rect(ctx, bitmap, GRect(rect.origin.x + (rect.size.w - size.w) / 2,
                                                  rect.origin.y + (rect.size.h - size.h) / 2, size.w, size.h));
  graphics_context_set_compositing_mode(ctx, GCompOpAssign);
}

// The team's logo, faintly tinted from the panel toward fg, centered in rect.
static void prv_draw_logo(GContext *ctx, GRect rect, GColor panel, GColor fg) {
  if (!s_logo) return;
  // The logo's palette is transparent plus one color, which takes the tint.
  GColor *palette = gbitmap_get_palette(s_logo);
  for (int i = 0; i < 2; i++) {
    if (palette[i].a) palette[i] = prv_tint(panel, fg);
  }
  prv_draw_centered(ctx, s_logo, rect);
}

// True when the team plays today: its next game is today, or a game is on or just over.
static bool prv_game_today(void) {
  switch (s_data.game_state) {
    case STATE_LIVE:
    case STATE_FINAL:
      return true;
    case STATE_NEXT:
      return s_data.game_start < time_start_of_today() + SECONDS_PER_DAY;
    default:
      return false;
  }
}

// Whether the NHL block shows the logo instead of the game and standings: on days
// without a game, and on game days only while a wrist flick has it swapped.
static bool prv_show_logo(void) {
  return s_logo && prv_game_today() == (s_flick_timer != NULL);
}

// One line of the goal banner, which may wrap onto up to max_lines lines.
typedef struct {
  const char *text;
  const char *font_key;
  int max_lines;
  int line_h;
} BannerLine;

// The team's latest goal: GOAL!, the scorer, assists, period and time, and the
// score, spaced evenly down rect.
static void prv_draw_goal_banner(GContext *ctx, GRect rect, bool big, GColor fg) {
  const BannerLine lines[] = {
    { "GOAL!", big ? FONT_KEY_GOTHIC_28_BOLD : FONT_KEY_GOTHIC_24_BOLD, 1, big ? 28 : 24 },
    { s_goal_scorer, big ? FONT_KEY_GOTHIC_24_BOLD : FONT_KEY_GOTHIC_18_BOLD, 1, big ? 24 : 18 },
    { s_goal_assists, big ? FONT_KEY_GOTHIC_18_BOLD : FONT_KEY_GOTHIC_14_BOLD, 2, big ? 18 : 14 },
    { s_goal_time, big ? FONT_KEY_GOTHIC_18_BOLD : FONT_KEY_GOTHIC_14_BOLD, 1, big ? 18 : 14 },
    { s_goal_score, big ? FONT_KEY_GOTHIC_24_BOLD : FONT_KEY_GOTHIC_18_BOLD, 1, big ? 24 : 18 },
  };
  const int n = ARRAY_LENGTH(lines);
  int heights[ARRAY_LENGTH(lines)];
  int total = 0;
  for (int i = 0; i < n; i++) {
    // Room for the font's descenders below the last line.
    GRect box = GRect(0, 0, rect.size.w, lines[i].max_lines * lines[i].line_h + lines[i].line_h / 3);
    heights[i] = graphics_text_layout_get_content_size(lines[i].text, fonts_get_system_font(lines[i].font_key),
                                                       box, GTextOverflowModeTrailingEllipsis,
                                                       GTextAlignmentCenter).h;
    total += heights[i];
  }
  const int spare = rect.size.h - total;
  const int space = spare > 0 ? spare / (n + 1) : 0;
  int y = rect.origin.y + (spare > 0 ? (spare - space * (n - 1)) / 2 : 0);
  graphics_context_set_text_color(ctx, fg);
  for (int i = 0; i < n; i++) {
    // Gothic text sits a few pixels below the top of its box.
    graphics_draw_text(ctx, lines[i].text, fonts_get_system_font(lines[i].font_key),
                       GRect(rect.origin.x, y - lines[i].line_h / 6, rect.size.w, heights[i] + 4),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
    y += heights[i] + space;
  }
}

static void prv_canvas_update(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);
  const int w = b.size.w;
  const int h = b.size.h;
  const bool big = h >= 200;

  // Main color for the background and block panels; second color for the block
  // borders, the label tabs, and the bubbles.
  const GColor bg = prv_color(s_data.primary, GColorBlack);
  const GColor panel = bg;
  const GColor panel_fg = prv_color(s_data.text, GColorWhite);
  const GColor accent = prv_color(s_data.secondary, GColorWhite);
  const GColor accent_fg = prv_color(s_data.text2, GColorBlack);
  const GColor stripe = prv_color(s_data.tertiary, GColorBlack);
  // Labels set into the pinstripes, on tabs and bubbles of the second color.
  const GColor tab_fg = prv_color(s_data.label, GColorBlack);

  graphics_context_set_fill_color(ctx, bg);
  graphics_fill_rect(ctx, b, 0, GCornerNone);

  // Watch block takes the top third, NHL block the bottom two thirds.
  const int m = 3;
  const int split = h / 3;
  GRect watch = GRect(m, m, w - 2 * m, split - m - m / 2);
  GRect nhl = GRect(m, split + (m + 1) / 2, w - 2 * m, h - split - (m + 1) / 2 - m);
  // Deep enough that a label centered on the stripe stays inside the block.
  const int inset = big ? 6 : 5;
  // How far the border band continues past the pinstripe.
  const int band = big ? 3 : 2;
  prv_draw_block(ctx, watch, inset, band, accent, panel, stripe);
  prv_draw_block(ctx, nhl, inset, band, accent, panel, stripe);

  const Font label_font = big ? FONT_18_BOLD : FONT_14_BOLD;
  const Font value_font = big ? FONT_24_BOLD : FONT_18_BOLD;
  const int label_half = (label_font.cap_h + 1) / 2;

  // Date set into the watch block's top pinstripe, time centered below it.
  GRect watch_in = grect_inset(watch, GEdgeInsets(inset));
  const char *date = s_date_buf;
#ifdef PREVIEW
  if (s_preview_label[0]) date = s_preview_label;
#endif
  prv_draw_stripe_label(ctx, date, label_font, watch_in.origin.x + 8, watch_in.origin.y,
                        watch_in.size.w - 16, true, accent, tab_fg);
  const Font time_font = big ? FONT_TIME_BIG : FONT_TIME_SMALL;
  const int time_top = watch_in.origin.y + label_half;
  const int time_bottom = watch_in.origin.y + watch_in.size.h - 1 - band;
  prv_draw_caps(ctx, s_time_buf, time_font, watch_in.origin.x,
                time_top + (time_bottom - time_top - time_font.cap_h + 1) / 2, watch_in.size.w, panel_fg);

  // Status badges centered side by side in the watch block's bottom pinstripe.
  const int badge_r = big ? 6 : 4;
  const int badge_gap = 4;
  const int badges = s_quiet_time + !s_bt_connected;
  const int badges_w = badges * BADGE_TAB_W(badge_r) + (badges - 1) * badge_gap;
  const int badge_y = watch_in.origin.y + watch_in.size.h - 1;
  int badge_x = watch_in.origin.x + (watch_in.size.w - badges_w) / 2 + BADGE_TAB_W(badge_r) / 2;
  if (!s_bt_connected) {
    prv_draw_bt_off_tab(ctx, GPoint(badge_x, badge_y), badge_r, accent, accent_fg);
    badge_x += BADGE_TAB_W(badge_r) + badge_gap;
  }
  if (s_quiet_time) {
    prv_draw_quiet_tab(ctx, GPoint(badge_x, badge_y), badge_r, accent, accent_fg);
  }

  // Game: live score, final score, or next game
  const char *line1 = s_data.line1;
  const char *line2 = s_data.line2;
  if (s_data.game_state == STATE_NEXT) {
    prv_format_next();
    line1 = s_next1_buf;
    line2 = s_next2_buf;
  } else if (s_data.game_state == STATE_NONE && s_data.record[0]) {
    line1 = "NO GAMES";
    line2 = "SCHEDULED";
  }

  GRect inner = grect_inset(nhl, GEdgeInsets(inset));
  const bool panel_only = s_banner_timer || prv_show_logo();
  if (panel_only && !s_banner_timer) {
    prv_load_color_logo();
  } else {
    prv_unload_color_logo();
  }
  if (panel_only) {
    // The logo, and the goal banner over it, take the whole panel below the team name.
    GRect panel_rect = grect_inset(inner, GEdgeInsets(band));
    const int top = inner.origin.y + label_half + 1;
    GRect area = GRect(panel_rect.origin.x + 2, top, panel_rect.size.w - 4,
                       panel_rect.origin.y + panel_rect.size.h - 1 - top);
    if (s_banner_timer) {
      prv_draw_logo(ctx, area, panel, panel_fg);
      prv_draw_goal_banner(ctx, area, big, panel_fg);
    } else if (s_color_logo) {
      prv_draw_centered(ctx, s_color_logo, area);
    } else {
      prv_draw_logo(ctx, area, panel, panel_fg);
    }
  }

  // Team name set into the NHL block's top pinstripe.
  prv_draw_stripe_label(ctx, s_data.team_name, label_font, inner.origin.x + 8, inner.origin.y,
                        inner.size.w - 16, true, accent, tab_fg);
  if (panel_only) return;

  // Three rows of bubbles spaced evenly below the team name:
  // the game, then RECORD | PTS, then division | NHL.
  const int pad = big ? 5 : 4;
  const int gap = big ? 6 : 4;
  const int bubble_h = 2 * BUBBLE_STRIPE_INSET + label_half + value_font.cap_h + (big ? 8 : 3);
  const int bx = inner.origin.x + pad;
  const int bw = inner.size.w - 2 * pad;
  // Label tabs reach one pixel above the label's capitals, which are centered on
  // the bubble's pinstripe.
  const int tab_half = label_half + 1 - BUBBLE_STRIPE_INSET;
  const int avail = inner.size.h - 1 - band - label_half;
  const int spare = avail - 3 * (bubble_h + tab_half);
  const int space = spare / 4;
  const int extra = spare % 4;
  const int row0_y = inner.origin.y + label_half + space + (extra > 0) + tab_half;
  const int row1_y = row0_y + bubble_h + space + (extra > 1) + tab_half;
  const int row2_y = row1_y + bubble_h + space + (extra > 2) + tab_half;

  prv_draw_bubble(ctx, GRect(bx, row0_y, bw, bubble_h), line1, label_font, line2, value_font,
                  accent, stripe, tab_fg, accent_fg);

  const int record_w = (bw - gap) * 5 / 8;
  const int col_w = (bw - gap) / 2;
  prv_draw_bubble(ctx, GRect(bx, row1_y, record_w, bubble_h), "RECORD", label_font,
                  s_data.record, value_font, accent, stripe, tab_fg, accent_fg);
  prv_draw_bubble(ctx, GRect(bx + record_w + gap, row1_y, bw - record_w - gap, bubble_h), "PTS", label_font,
                  s_data.points, value_font, accent, stripe, tab_fg, accent_fg);
  prv_draw_bubble(ctx, GRect(bx, row2_y, col_w, bubble_h), s_data.div_name[0] ? s_data.div_name : "DIV",
                  label_font, s_data.div_rank, value_font, accent, stripe, tab_fg, accent_fg);
  prv_draw_bubble(ctx, GRect(bx + bw - col_w, row2_y, col_w, bubble_h), "NHL", label_font,
                  s_data.league_rank, value_font, accent, stripe, tab_fg, accent_fg);
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
  // There's no Quiet Time event, so check it each minute along with the time.
  s_quiet_time = quiet_time_is_active();
  layer_mark_dirty(s_canvas);
}

static void prv_tick_handler(struct tm *tick_time, TimeUnits units_changed) {
  prv_update_time();
  if (--s_refresh_countdown <= 0) {
    prv_reset_countdown();
    prv_request_update();
  }
}

// Short, short, long: distinct from a notification buzz.
static const uint32_t GOAL_VIBE[] = { 150, 100, 150, 100, 500 };
// Three quick buzzes when the other team scores.
static const uint32_t OPP_GOAL_VIBE[] = { 100, 100, 100, 100, 100 };
// Two long buzzes for the final horn.
static const uint32_t FINAL_VIBE[] = { 500, 250, 500 };

static void prv_bt_handler(bool connected) {
  s_bt_connected = connected;
  if (!connected && s_vibe_on_disconnect && !quiet_time_is_active()) {
    vibes_double_pulse();
  }
  layer_mark_dirty(s_canvas);
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

static void prv_banner_timeout(void *context) {
  s_banner_timer = NULL;
  layer_mark_dirty(s_canvas);
}

#ifdef PBL_COLOR
static void prv_flick_timeout(void *context) {
  s_flick_timer = NULL;
  layer_mark_dirty(s_canvas);
}

// A wrist flick swaps the NHL block between the logo and the game and standings
// for a few seconds, or swaps it back early.
static void prv_tap_handler(AccelAxisType axis, int32_t direction) {
  if (s_flick_timer) {
    app_timer_cancel(s_flick_timer);
    s_flick_timer = NULL;
  } else {
    s_flick_timer = app_timer_register(FLICK_SECS * 1000, prv_flick_timeout, NULL);
  }
  layer_mark_dirty(s_canvas);
}
#endif

// Shows the goal banner if the phone sent one, restarting its timer. A score
// sent on its own updates the banner already up.
static void prv_show_goal_banner(DictionaryIterator *iter) {
  Tuple *scorer = dict_find(iter, MESSAGE_KEY_GoalScorer);
  if (!scorer) {
    if (s_banner_timer) prv_copy_string(s_goal_score, sizeof(s_goal_score), dict_find(iter, MESSAGE_KEY_GoalScore));
    return;
  }
  prv_copy_string(s_goal_scorer, sizeof(s_goal_scorer), scorer);
  prv_copy_string(s_goal_assists, sizeof(s_goal_assists), dict_find(iter, MESSAGE_KEY_GoalAssists));
  prv_copy_string(s_goal_time, sizeof(s_goal_time), dict_find(iter, MESSAGE_KEY_GoalTime));
  prv_copy_string(s_goal_score, sizeof(s_goal_score), dict_find(iter, MESSAGE_KEY_GoalScore));
  int32_t secs = GOAL_BANNER_SECS;
  prv_copy_int(&secs, dict_find(iter, MESSAGE_KEY_GoalBannerSecs));
  const uint32_t ms = (secs > 0 ? secs : GOAL_BANNER_SECS) * 1000;
  if (!s_banner_timer || !app_timer_reschedule(s_banner_timer, ms)) {
    s_banner_timer = app_timer_register(ms, prv_banner_timeout, NULL);
  }
  if (!quiet_time_is_active()) light_enable_interaction();
}

#ifdef PREVIEW
// Preview build (tools/preview.sh): the buttons ask the phone for the next or
// previous team color scheme, or to flip home and away.
static void prv_preview_step(int step) {
  DictionaryIterator *iter;
  if (app_message_outbox_begin(&iter) != APP_MSG_OK) return;
  dict_write_int8(iter, MESSAGE_KEY_PreviewStep, step);
  app_message_outbox_send();
}

static void prv_preview_up(ClickRecognizerRef recognizer, void *context) { prv_preview_step(-1); }
static void prv_preview_down(ClickRecognizerRef recognizer, void *context) { prv_preview_step(1); }
static void prv_preview_select(ClickRecognizerRef recognizer, void *context) { prv_preview_step(0); }

static void prv_preview_clicks(void *context) {
  window_single_repeating_click_subscribe(BUTTON_ID_UP, 300, prv_preview_up);
  window_single_repeating_click_subscribe(BUTTON_ID_DOWN, 300, prv_preview_down);
  window_single_click_subscribe(BUTTON_ID_SELECT, prv_preview_select);
}
#endif

static void prv_inbox_received(DictionaryIterator *iter, void *context) {
#ifdef PREVIEW
  // Only the preview's own messages, not the face's live updates.
  Tuple *label = dict_find(iter, MESSAGE_KEY_PreviewLabel);
  if (!label) return;
  prv_copy_string(s_preview_label, sizeof(s_preview_label), label);
#endif
  prv_copy_string(s_data.team_name, sizeof(s_data.team_name), dict_find(iter, MESSAGE_KEY_TeamName));
  Tuple *abbrev = dict_find(iter, MESSAGE_KEY_TeamAbbrev);
  if (abbrev && strcmp(abbrev->value->cstring, s_data.team_abbrev) != 0) {
    // A different team: its logo replaces the old one.
    prv_copy_string(s_data.team_abbrev, sizeof(s_data.team_abbrev), abbrev);
    prv_unload_logo();
    prv_load_logo();
  }
  prv_copy_int(&s_data.primary, dict_find(iter, MESSAGE_KEY_ColorPrimary));
  prv_copy_int(&s_data.secondary, dict_find(iter, MESSAGE_KEY_ColorSecondary));
  prv_copy_int(&s_data.tertiary, dict_find(iter, MESSAGE_KEY_ColorTertiary));
  prv_copy_int(&s_data.text, dict_find(iter, MESSAGE_KEY_ColorText));
  prv_copy_int(&s_data.text2, dict_find(iter, MESSAGE_KEY_ColorText2));
  prv_copy_int(&s_data.label, dict_find(iter, MESSAGE_KEY_ColorLabel));
  prv_copy_string(s_data.record, sizeof(s_data.record), dict_find(iter, MESSAGE_KEY_Record));
  prv_copy_string(s_data.points, sizeof(s_data.points), dict_find(iter, MESSAGE_KEY_Points));
  prv_copy_string(s_data.div_name, sizeof(s_data.div_name), dict_find(iter, MESSAGE_KEY_DivName));
  prv_copy_string(s_data.div_rank, sizeof(s_data.div_rank), dict_find(iter, MESSAGE_KEY_DivRank));
  prv_copy_string(s_data.league_rank, sizeof(s_data.league_rank), dict_find(iter, MESSAGE_KEY_LeagueRank));
  prv_copy_int(&s_data.refresh_mins, dict_find(iter, MESSAGE_KEY_RefreshMins));
  if (!quiet_time_is_active()) {
    Tuple *buzz = dict_find(iter, MESSAGE_KEY_GameBuzz);
    Tuple *goal = dict_find(iter, MESSAGE_KEY_GoalScored);
    if (goal && goal->value->int32 == GOAL_OPP) {
      vibes_enqueue_custom_pattern((VibePattern) {
        .durations = OPP_GOAL_VIBE,
        .num_segments = ARRAY_LENGTH(OPP_GOAL_VIBE),
      });
    } else if (goal) {
      vibes_enqueue_custom_pattern((VibePattern) {
        .durations = GOAL_VIBE,
        .num_segments = ARRAY_LENGTH(GOAL_VIBE),
      });
    } else if (buzz && buzz->value->int32 == BUZZ_FINAL) {
      vibes_enqueue_custom_pattern((VibePattern) {
        .durations = FINAL_VIBE,
        .num_segments = ARRAY_LENGTH(FINAL_VIBE),
      });
    } else if (buzz && buzz->value->int32 == BUZZ_PERIOD) {
      vibes_long_pulse();
    }
  }
  prv_show_goal_banner(iter);
  Tuple *vibe = dict_find(iter, MESSAGE_KEY_VibeOnDisconnect);
  if (vibe) {
    s_vibe_on_disconnect = vibe->value->int32 != 0;
    persist_write_bool(PERSIST_KEY_VIBE, s_vibe_on_disconnect);
  }

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
  prv_load_logo();
  prv_update_time();
}

static void prv_window_unload(Window *window) {
  prv_unload_logo();
  prv_unload_color_logo();
  layer_destroy(s_canvas);
}

static void prv_init(void) {
  prv_load_data();
  prv_reset_countdown();
  s_vibe_on_disconnect = persist_read_bool(PERSIST_KEY_VIBE);

  s_window = window_create();
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = prv_window_load,
    .unload = prv_window_unload,
  });
#ifdef PREVIEW
  window_set_click_config_provider(s_window, prv_preview_clicks);
#endif
  window_stack_push(s_window, true);

  tick_timer_service_subscribe(MINUTE_UNIT, prv_tick_handler);
#ifdef PBL_COLOR
  // Only color watches have the logo to swap to.
  accel_tap_service_subscribe(prv_tap_handler);
#endif
  s_bt_connected = connection_service_peek_pebble_app_connection();
  connection_service_subscribe((ConnectionHandlers) {
    .pebble_app_connection_handler = prv_bt_handler,
  });
  app_message_register_inbox_received(prv_inbox_received);
  app_message_open(512, 64);
}

static void prv_deinit(void) {
  tick_timer_service_unsubscribe();
#ifdef PBL_COLOR
  accel_tap_service_unsubscribe();
#endif
  connection_service_unsubscribe();
  window_destroy(s_window);
}

int main(void) {
  prv_init();
  app_event_loop();
  prv_deinit();
}
