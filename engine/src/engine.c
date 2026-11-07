/*
 * OpenTunes engine: a small C interface over libgpod, built for use from JavaScript.
 *
 * Design
 * - One database is open at a time. Tracks and playlists are referred to by integer
 *   handles (1, 2, 3, ...) that stay valid until the database is closed or reopened.
 *   Removing one track never changes another track's handle.
 * - Track fields are read and written by name through one table (FIELDS). The JSON the
 *   engine returns and the setters therefore cannot disagree, and a new field is one line.
 * - A track's kind (music, movie, podcast, audiobook, ...) is a preset. It sets libgpod's
 *   media type and the flags that belong with it, and keeps podcast playlist membership
 *   right. The presets follow libgpod's own documentation of Itdb_Track.
 * - Functions return 0 or a handle on success and -1 on failure, with the reason in
 *   ot_last_error(). Functions that return a string return NULL on failure. A returned
 *   string points into an engine-owned buffer that stays valid until the next call that
 *   returns a string, so callers copy it straight away.
 * - Existing data is left alone. In particular smart playlists are written back as they
 *   were found: if libgpod cannot write them, the write fails with an error.
 *
 * - ot_sqlite_query_json reads the SQLite files of a nano 6G/7G library, read only, so a
 *   rewrite can be compared with what the iPod holds. It is independent of the open database.
 *
 * Not here yet: album artwork (libgpod needs gdk-pixbuf for it, which is not built).
 */

#include <math.h>
#include <string.h>
#include <time.h>

#include <emscripten.h>
#include <glib.h>
#include <sqlite3.h>

#include "itdb.h"
#include "itdb_device.h"

#define OT_API_VERSION "1"

/* ------------------------------------------------------------------ state */

static Itdb_iTunesDB *db = NULL;
static gchar *mountpoint = NULL;
static GString *error_text = NULL;
static GString *out = NULL; /* backs every string returned to the caller */

typedef struct {
    GPtrArray *items;  /* handle N is items[N - 1], NULL once forgotten */
    GHashTable *ids;   /* object pointer -> handle */
} Handles;

static Handles track_handles;
static Handles playlist_handles;

static void handles_init(Handles *h)
{
    h->items = g_ptr_array_new();
    h->ids = g_hash_table_new(g_direct_hash, g_direct_equal);
}

static int handle_of(Handles *h, gpointer object)
{
    gpointer found = g_hash_table_lookup(h->ids, object);
    if (found) {
        return GPOINTER_TO_INT(found);
    }
    g_ptr_array_add(h->items, object);
    int id = (int) h->items->len;
    g_hash_table_insert(h->ids, object, GINT_TO_POINTER(id));
    return id;
}

static gpointer object_of(Handles *h, int id)
{
    if (id < 1 || (guint) id > h->items->len) {
        return NULL;
    }
    return g_ptr_array_index(h->items, id - 1);
}

static void forget(Handles *h, gpointer object)
{
    gpointer found = g_hash_table_lookup(h->ids, object);
    if (!found) {
        return;
    }
    g_ptr_array_index(h->items, GPOINTER_TO_INT(found) - 1) = NULL;
    g_hash_table_remove(h->ids, object);
}

static void handles_reset(Handles *h)
{
    g_ptr_array_set_size(h->items, 0);
    g_hash_table_remove_all(h->ids);
}

__attribute__((constructor)) static void state_init(void)
{
    error_text = g_string_new("");
    out = g_string_new("");
    handles_init(&track_handles);
    handles_init(&playlist_handles);
}

/* ----------------------------------------------------------------- errors */

static int fail(const char *format, ...) G_GNUC_PRINTF(1, 2);
static int fail(const char *format, ...)
{
    va_list args;
    va_start(args, format);
    g_string_vprintf(error_text, format, args);
    va_end(args);
    return -1;
}

static int fail_from(const char *what, GError *error)
{
    fail("%s: %s", what, error ? error->message : "unknown error");
    if (error) {
        g_error_free(error);
    }
    return -1;
}

static void clear_error(void)
{
    g_string_truncate(error_text, 0);
}

#define REQUIRE_DB(result)                       \
    do {                                         \
        if (!db) {                               \
            fail("No database is open.");        \
            return (result);                     \
        }                                        \
    } while (0)

static Itdb_Track *track_of(int handle)
{
    Itdb_Track *track = object_of(&track_handles, handle);
    if (!track) {
        fail("Unknown track handle %d.", handle);
    }
    return track;
}

static Itdb_Playlist *playlist_of(int handle)
{
    Itdb_Playlist *playlist = object_of(&playlist_handles, handle);
    if (!playlist) {
        fail("Unknown playlist handle %d.", handle);
    }
    return playlist;
}

/* ------------------------------------------------------------------ JSON */

static void json_string(GString *s, const gchar *text)
{
    gchar *valid = g_utf8_make_valid(text, -1);
    g_string_append_c(s, '"');
    for (const guchar *c = (const guchar *) valid; *c; c++) {
        switch (*c) {
        case '"':
            g_string_append(s, "\\\"");
            break;
        case '\\':
            g_string_append(s, "\\\\");
            break;
        case '\n':
            g_string_append(s, "\\n");
            break;
        case '\r':
            g_string_append(s, "\\r");
            break;
        case '\t':
            g_string_append(s, "\\t");
            break;
        default:
            if (*c < 0x20) {
                g_string_append_printf(s, "\\u%04x", *c);
            } else {
                g_string_append_c(s, (gchar) *c);
            }
        }
    }
    g_string_append_c(s, '"');
    g_free(valid);
}

static void json_key(GString *s, const char *name)
{
    json_string(s, name);
    g_string_append_c(s, ':');
}

static void json_optional_string(GString *s, const gchar *text)
{
    if (text) {
        json_string(s, text);
    } else {
        g_string_append(s, "null");
    }
}

/* ----------------------------------------------------------------- kinds */

typedef struct {
    const char *name;
    guint32 mediatype;
    guint8 movie_flag;
    guint8 skip_when_shuffling;
    guint8 remember_playback_position;
    guint8 flag4;
    guint8 mark_unplayed;
    gboolean in_podcast_playlist;
} Kind;

/*
 * Values from libgpod's documentation of Itdb_Track:
 * - mediatype decides which menu a track appears under.
 * - Podcasts: flag4 1 shows Title/Album on Now Playing, mark_unplayed 2 shows the
 *   unplayed bullet, and the track belongs in the playlist flagged as the podcast list.
 * - Audiobooks always remember their position and skip shuffle, so those are set too.
 * - 0x40 shows a TV show only under TV Shows. (0x60 also shows it in Music.)
 */
static const Kind KINDS[] = {
    { "music",         ITDB_MEDIATYPE_AUDIO,                          0, 0, 0, 0, 1, FALSE },
    { "movie",         ITDB_MEDIATYPE_MOVIE,                          1, 0, 0, 0, 1, FALSE },
    { "music-video",   ITDB_MEDIATYPE_MUSICVIDEO,                     1, 0, 0, 0, 1, FALSE },
    { "tv-show",       ITDB_MEDIATYPE_TVSHOW,                         1, 0, 0, 0, 1, FALSE },
    { "podcast",       ITDB_MEDIATYPE_PODCAST,                        0, 1, 1, 1, 2, TRUE  },
    { "video-podcast", ITDB_MEDIATYPE_PODCAST | ITDB_MEDIATYPE_MOVIE, 1, 1, 1, 1, 2, TRUE  },
    { "audiobook",     ITDB_MEDIATYPE_AUDIOBOOK,                      0, 1, 1, 0, 1, FALSE },
};

static const Kind *kind_by_name(const char *name)
{
    for (gsize i = 0; i < G_N_ELEMENTS(KINDS); i++) {
        if (name && strcmp(KINDS[i].name, name) == 0) {
            return &KINDS[i];
        }
    }
    return NULL;
}

/* Names a track's kind for the caller. Files from other software can carry values that
 * match no preset exactly, so fall back to the bits that are set. */
static const char *kind_name_of(guint32 mediatype)
{
    for (gsize i = 0; i < G_N_ELEMENTS(KINDS); i++) {
        if (KINDS[i].mediatype == mediatype) {
            return KINDS[i].name;
        }
    }
    if (mediatype == 0) {
        return "unspecified";
    }
    if (mediatype & ITDB_MEDIATYPE_AUDIOBOOK) {
        return "audiobook";
    }
    if (mediatype & ITDB_MEDIATYPE_PODCAST) {
        return (mediatype & ITDB_MEDIATYPE_MOVIE) ? "video-podcast" : "podcast";
    }
    if (mediatype & ITDB_MEDIATYPE_TVSHOW) {
        return "tv-show";
    }
    if (mediatype & ITDB_MEDIATYPE_MUSICVIDEO) {
        return "music-video";
    }
    if (mediatype & ITDB_MEDIATYPE_MOVIE) {
        return "movie";
    }
    if (mediatype & ITDB_MEDIATYPE_AUDIO) {
        return "music";
    }
    return "other";
}

/* The playlist the iPod lists under Podcasts. Created on demand. */
static Itdb_Playlist *podcast_playlist(gboolean create)
{
    Itdb_Playlist *playlist = itdb_playlist_podcasts(db);
    if (!playlist && create) {
        playlist = itdb_playlist_new("Podcasts", FALSE);
        itdb_playlist_set_podcasts(playlist);
        itdb_playlist_add(db, playlist, -1);
    }
    return playlist;
}

static void sync_podcast_membership(Itdb_Track *track, gboolean wanted)
{
    Itdb_Playlist *playlist = podcast_playlist(wanted);
    if (!playlist) {
        return;
    }
    gboolean present = itdb_playlist_contains_track(playlist, track);
    if (wanted && !present) {
        itdb_playlist_add_track(playlist, track, -1);
    } else if (!wanted && present) {
        itdb_playlist_remove_track(playlist, track);
    }
}

static void apply_kind(Itdb_Track *track, const Kind *kind)
{
    track->mediatype = kind->mediatype;
    track->movie_flag = kind->movie_flag;
    track->skip_when_shuffling = kind->skip_when_shuffling;
    track->remember_playback_position = kind->remember_playback_position;
    track->flag4 = kind->flag4;
    track->mark_unplayed = kind->mark_unplayed;
    sync_podcast_membership(track, kind->in_podcast_playlist);
}

/* ---------------------------------------------------------------- fields */

typedef enum {
    T_STR, T_I32, T_U32, T_I16, T_U16, T_U8, T_U64, T_FLOAT, T_TIME, T_BOOL
} FieldType;

typedef struct {
    const char *name;
    FieldType type;
    gsize offset;
    gboolean writable;
} Field;

#define STR(n)       { #n, T_STR, G_STRUCT_OFFSET(Itdb_Track, n), TRUE }
#define NUM(n, type) { #n, type,  G_STRUCT_OFFSET(Itdb_Track, n), TRUE }
#define RO(n, type)  { #n, type,  G_STRUCT_OFFSET(Itdb_Track, n), FALSE }

static const Field FIELDS[] = {
    STR(title), STR(album), STR(artist), STR(albumartist), STR(genre), STR(composer),
    STR(comment), STR(grouping), STR(category), STR(description), STR(subtitle),
    STR(keywords), STR(podcasturl), STR(podcastrss), STR(tvshow), STR(tvepisode),
    STR(tvnetwork), STR(sort_artist), STR(sort_title), STR(sort_album),
    STR(sort_albumartist), STR(sort_composer), STR(sort_tvshow), STR(filetype),

    NUM(track_nr, T_I32), NUM(tracks, T_I32), NUM(cd_nr, T_I32), NUM(cds, T_I32),
    NUM(year, T_I32), NUM(tracklen, T_I32), NUM(bitrate, T_I32), NUM(samplerate, T_U16),
    NUM(volume, T_I32), NUM(soundcheck, T_U32), NUM(rating, T_U32), NUM(playcount, T_U32),
    NUM(bookmark_time, T_U32), NUM(starttime, T_U32), NUM(stoptime, T_U32),
    NUM(BPM, T_I16), NUM(compilation, T_U8), NUM(explicit_flag, T_U16),
    NUM(season_nr, T_U32), NUM(episode_nr, T_U32), NUM(size, T_U32),
    NUM(skip_when_shuffling, T_U8), NUM(remember_playback_position, T_U8),
    NUM(flag4, T_U8), NUM(mark_unplayed, T_U8), NUM(movie_flag, T_U8),
    NUM(lyrics_flag, T_U8), NUM(visible, T_U32), NUM(checked, T_U8),
    NUM(app_rating, T_U8), NUM(type1, T_U8), NUM(type2, T_U8),
    NUM(pregap, T_U32), NUM(postgap, T_U32), NUM(samplecount, T_U64),
    NUM(gapless_data, T_U32), NUM(gapless_track_flag, T_U16),
    NUM(gapless_album_flag, T_U16),
    NUM(time_added, T_TIME), NUM(time_modified, T_TIME), NUM(time_played, T_TIME),
    NUM(time_released, T_TIME),

    /* Set by the engine, not by callers. mediatype changes only through a kind. */
    RO(id, T_U32), RO(mediatype, T_U32), RO(ipod_path, T_STR), RO(transferred, T_BOOL),
    RO(has_artwork, T_U8), RO(artwork_count, T_U16), RO(filetype_marker, T_U32),
};

static const Field *field_named(const char *name)
{
    for (gsize i = 0; i < G_N_ELEMENTS(FIELDS); i++) {
        if (name && strcmp(FIELDS[i].name, name) == 0) {
            return &FIELDS[i];
        }
    }
    return NULL;
}

static void json_field(GString *s, const Field *field, const Itdb_Track *track)
{
    const guint8 *p = (const guint8 *) track + field->offset;
    switch (field->type) {
    case T_STR:
        json_optional_string(s, *(const gchar *const *) p);
        break;
    case T_I32:
        g_string_append_printf(s, "%d", *(const gint32 *) p);
        break;
    case T_U32:
        g_string_append_printf(s, "%u", *(const guint32 *) p);
        break;
    case T_I16:
        g_string_append_printf(s, "%d", *(const gint16 *) p);
        break;
    case T_U16:
        g_string_append_printf(s, "%u", *(const guint16 *) p);
        break;
    case T_U8:
        g_string_append_printf(s, "%u", *(const guint8 *) p);
        break;
    case T_U64:
        g_string_append_printf(s, "%" G_GUINT64_FORMAT, *(const guint64 *) p);
        break;
    case T_FLOAT:
        g_string_append_printf(s, "%g", (double) *(const float *) p);
        break;
    case T_TIME:
        g_string_append_printf(s, "%" G_GINT64_FORMAT, (gint64) *(const time_t *) p);
        break;
    case T_BOOL:
        g_string_append(s, *(const gboolean *) p ? "true" : "false");
        break;
    }
}

/* Stores a number into a field, clamped to the field's range. */
static gboolean store_number(const Field *field, Itdb_Track *track, double value)
{
    guint8 *p = (guint8 *) track + field->offset;
    switch (field->type) {
    case T_I32:
        *(gint32 *) p = (gint32) CLAMP(value, (double) G_MININT32, (double) G_MAXINT32);
        return TRUE;
    case T_U32:
        *(guint32 *) p = (guint32) CLAMP(value, 0.0, (double) G_MAXUINT32);
        return TRUE;
    case T_I16:
        *(gint16 *) p = (gint16) CLAMP(value, (double) G_MININT16, (double) G_MAXINT16);
        return TRUE;
    case T_U16:
        *(guint16 *) p = (guint16) CLAMP(value, 0.0, (double) G_MAXUINT16);
        return TRUE;
    case T_U8:
        *(guint8 *) p = (guint8) CLAMP(value, 0.0, (double) G_MAXUINT8);
        return TRUE;
    case T_U64:
        *(guint64 *) p = (guint64) CLAMP(value, 0.0, 9007199254740992.0); /* 2^53 */
        return TRUE;
    case T_FLOAT:
        *(float *) p = (float) value;
        return TRUE;
    case T_TIME:
        *(time_t *) p = (time_t) value;
        return TRUE;
    default:
        return FALSE;
    }
}

/* ------------------------------------------------------------- lifecycle */

static void close_db(void)
{
    if (db) {
        itdb_free(db);
        db = NULL;
    }
    handles_reset(&track_handles);
    handles_reset(&playlist_handles);
}

EMSCRIPTEN_KEEPALIVE
const char *ot_api_version(void)
{
    return OT_API_VERSION;
}

EMSCRIPTEN_KEEPALIVE
const char *ot_last_error(void)
{
    return error_text->str;
}

/* Reads the database found at the mount point. Fails if there is none: use ot_init for an
 * iPod that has never been set up. */
EMSCRIPTEN_KEEPALIVE
int ot_open(const char *mount)
{
    clear_error();
    if (!mount || !*mount) {
        return fail("A mount point is required.");
    }

    close_db();
    GError *error = NULL;
    db = itdb_parse(mount, &error);
    if (!db) {
        if (!error) {
            /* libgpod reads iTunesCDB first and iTunesDB second. When both are missing or
             * empty it fails without saying why, which is what an iPod that has never been
             * synced looks like. */
            return fail("Could not read the iPod database: there is no iTunesCDB, and any iTunesDB is empty. "
                        "An iPod that has never been synced looks like this.");
        }
        return fail_from("Could not read the iPod database", error);
    }

    g_free(mountpoint);
    mountpoint = g_strdup(mount);
    itdb_set_mountpoint(db, mountpoint);
    if (db->device) {
        itdb_device_read_sysinfo(db->device);
    }
    return 0;
}

/* Sets up an empty iPod with libgpod's own routine, then opens it. */
EMSCRIPTEN_KEEPALIVE
int ot_init(const char *mount, const char *model_number, const char *name)
{
    clear_error();
    if (!mount || !*mount) {
        return fail("A mount point is required.");
    }
    if (!model_number || !*model_number) {
        return fail("A model number is required to set up an iPod.");
    }

    GError *error = NULL;
    if (!itdb_init_ipod(mount, model_number, name && *name ? name : "iPod", &error)) {
        return fail_from("Could not set up the iPod", error);
    }
    return ot_open(mount);
}

/* Playlist members that point at tracks no longer in the database would make libgpod
 * abort the write. Our own removal never leaves any, so this is a safety net. */
static void drop_dangling_members(void)
{
    GHashTable *valid = g_hash_table_new(g_direct_hash, g_direct_equal);
    for (GList *t = db->tracks; t; t = t->next) {
        g_hash_table_add(valid, t->data);
    }
    for (GList *p = db->playlists; p; p = p->next) {
        Itdb_Playlist *playlist = p->data;
        GList *members = g_list_copy(playlist->members);
        for (GList *m = members; m; m = m->next) {
            if (!g_hash_table_contains(valid, m->data)) {
                playlist->members = g_list_remove(playlist->members, m->data);
                playlist->num--;
            }
        }
        g_list_free(members);
    }
    g_hash_table_destroy(valid);
}

EMSCRIPTEN_KEEPALIVE
int ot_write(void)
{
    clear_error();
    REQUIRE_DB(-1);

    itdb_set_mountpoint(db, mountpoint);
    drop_dangling_members();

    GError *error = NULL;
    if (!itdb_write(db, &error)) {
        return fail_from("Could not write the iPod database", error);
    }
    return 0;
}

EMSCRIPTEN_KEEPALIVE
void ot_close(void)
{
    close_db();
}

/* ---------------------------------------------------------------- device */

EMSCRIPTEN_KEEPALIVE
const char *ot_device_json(void)
{
    clear_error();
    if (!db || !db->device) {
        fail("No device information is available.");
        return NULL;
    }

    const Itdb_Device *device = db->device;
    const Itdb_IpodInfo *info = itdb_device_get_ipod_info(device);
    ItdbChecksumType checksum = itdb_device_get_checksum_type(device);
    const char *checksum_name = checksum == ITDB_CHECKSUM_NONE    ? "none"
                              : checksum == ITDB_CHECKSUM_HASH58  ? "hash58"
                              : checksum == ITDB_CHECKSUM_HASH72  ? "hash72"
                              : checksum == ITDB_CHECKSUM_HASHAB  ? "hashAB"
                                                                  : "unknown";

    gchar *firewire_guid = itdb_device_get_sysinfo(device, "FirewireGuid");
    gchar *serial = itdb_device_get_sysinfo(device, "SerialNumber");
    gchar *model_num_str = itdb_device_get_sysinfo(device, "ModelNumStr");
    gchar *board_type = itdb_device_get_sysinfo(device, "BoardType");
    const char *firewire_id = itdb_device_get_firewire_id(device);

    g_string_truncate(out, 0);
    g_string_append_c(out, '{');
    json_key(out, "model_name");
    json_optional_string(out, info ? itdb_info_get_ipod_model_name_string(info->ipod_model) : NULL);
    g_string_append_c(out, ',');
    json_key(out, "generation_name");
    json_optional_string(out, info ? itdb_info_get_ipod_generation_string(info->ipod_generation) : NULL);
    g_string_append_c(out, ',');
    json_key(out, "model_number");
    json_optional_string(out, info ? info->model_number : NULL);
    g_string_append_printf(out, ",\"generation\":%d,\"capacity_gb\":%.1f,\"ipod_model\":%d,",
                           info ? (int) info->ipod_generation : -1,
                           info ? (double) info->capacity : 0.0,
                           info ? (int) info->ipod_model : -1);
    json_key(out, "firewire_guid");
    json_optional_string(out, firewire_guid);
    g_string_append_c(out, ',');
    json_key(out, "firewire_id");
    json_optional_string(out, firewire_id);
    g_string_append_printf(out, ",\"checksum_type\":%d,", (int) checksum);
    json_key(out, "checksum");
    json_string(out, checksum_name);
    g_string_append_c(out, ',');
    json_key(out, "serial_number");
    json_optional_string(out, serial);
    g_string_append_c(out, ',');
    json_key(out, "model_num_str");
    json_optional_string(out, model_num_str);
    g_string_append_c(out, ',');
    json_key(out, "board_type");
    json_optional_string(out, board_type);
    g_string_append_printf(out,
        ",\"has_sysinfo_extended\":%s,\"device_recognized\":%s,"
        "\"supports\":{\"artwork\":%s,\"video\":%s,\"photo\":%s,\"podcast\":%s,\"chapter_image\":%s}}",
        device->sysinfo_extended ? "true" : "false",
        (info && info->ipod_generation > ITDB_IPOD_GENERATION_UNKNOWN) ? "true" : "false",
        itdb_device_supports_artwork(device) ? "true" : "false",
        itdb_device_supports_video(device) ? "true" : "false",
        itdb_device_supports_photo(device) ? "true" : "false",
        itdb_device_supports_podcast(device) ? "true" : "false",
        itdb_device_supports_chapter_image(device) ? "true" : "false");

    g_free(firewire_guid);
    g_free(serial);
    g_free(model_num_str);
    g_free(board_type);
    return out->str;
}

/* ---------------------------------------------------------------- tracks */

EMSCRIPTEN_KEEPALIVE
const char *ot_kinds_json(void)
{
    g_string_truncate(out, 0);
    g_string_append_c(out, '[');
    for (gsize i = 0; i < G_N_ELEMENTS(KINDS); i++) {
        if (i) {
            g_string_append_c(out, ',');
        }
        g_string_append_c(out, '{');
        json_key(out, "name");
        json_string(out, KINDS[i].name);
        g_string_append_printf(out, ",\"mediatype\":%u}", KINDS[i].mediatype);
    }
    g_string_append_c(out, ']');
    return out->str;
}

static void json_track(GString *s, Itdb_Track *track)
{
    g_string_append_printf(s, "{\"handle\":%d,\"kind\":", handle_of(&track_handles, track));
    json_string(s, kind_name_of(track->mediatype));
    for (gsize i = 0; i < G_N_ELEMENTS(FIELDS); i++) {
        g_string_append_c(s, ',');
        json_key(s, FIELDS[i].name);
        json_field(s, &FIELDS[i], track);
    }
    g_string_append(s, ",\"chapters\":[");
    if (track->chapterdata) {
        for (GList *c = track->chapterdata->chapters; c; c = c->next) {
            Itdb_Chapter *chapter = c->data;
            if (c != track->chapterdata->chapters) {
                g_string_append_c(s, ',');
            }
            g_string_append_printf(s, "{\"start\":%u,\"title\":", chapter->startpos);
            json_optional_string(s, chapter->chaptertitle);
            g_string_append_c(s, '}');
        }
    }
    g_string_append(s, "]}");
}

EMSCRIPTEN_KEEPALIVE
const char *ot_tracks_json(void)
{
    clear_error();
    REQUIRE_DB(NULL);

    g_string_truncate(out, 0);
    g_string_append_c(out, '[');
    for (GList *t = db->tracks; t; t = t->next) {
        if (t != db->tracks) {
            g_string_append_c(out, ',');
        }
        json_track(out, t->data);
    }
    g_string_append_c(out, ']');
    return out->str;
}

/* Creates a track of the given kind, in the database and the master playlist. The file
 * itself is added later: ask for a destination path, write the file there, then commit. */
EMSCRIPTEN_KEEPALIVE
int ot_track_new(const char *kind_name)
{
    clear_error();
    REQUIRE_DB(-1);

    const Kind *kind = kind_by_name(kind_name);
    if (!kind) {
        return fail("Unknown track kind \"%s\".", kind_name ? kind_name : "");
    }
    Itdb_Playlist *master = itdb_playlist_mpl(db);
    if (!master) {
        return fail("The database has no master playlist.");
    }

    Itdb_Track *track = itdb_track_new();
    track->time_added = time(NULL);
    track->time_modified = track->time_added;
    itdb_track_add(db, track, -1);
    itdb_playlist_add_track(master, track, -1);
    apply_kind(track, kind);
    return handle_of(&track_handles, track);
}

EMSCRIPTEN_KEEPALIVE
int ot_track_set_kind(int handle, const char *kind_name)
{
    clear_error();
    REQUIRE_DB(-1);

    Itdb_Track *track = track_of(handle);
    if (!track) {
        return -1;
    }
    const Kind *kind = kind_by_name(kind_name);
    if (!kind) {
        return fail("Unknown track kind \"%s\".", kind_name ? kind_name : "");
    }
    apply_kind(track, kind);
    track->time_modified = time(NULL);
    return 0;
}

EMSCRIPTEN_KEEPALIVE
int ot_track_set_string(int handle, const char *field_name, const char *value)
{
    clear_error();
    REQUIRE_DB(-1);

    Itdb_Track *track = track_of(handle);
    if (!track) {
        return -1;
    }
    const Field *field = field_named(field_name);
    if (!field || field->type != T_STR) {
        return fail("\"%s\" is not a text field.", field_name ? field_name : "");
    }
    if (!field->writable) {
        return fail("\"%s\" is set by the engine and cannot be changed.", field->name);
    }

    gchar **slot = (gchar **) ((guint8 *) track + field->offset);
    g_free(*slot);
    *slot = value ? g_utf8_make_valid(value, -1) : NULL;
    return 0;
}

EMSCRIPTEN_KEEPALIVE
int ot_track_set_number(int handle, const char *field_name, double value)
{
    clear_error();
    REQUIRE_DB(-1);

    Itdb_Track *track = track_of(handle);
    if (!track) {
        return -1;
    }
    const Field *field = field_named(field_name);
    if (!field || field->type == T_STR || field->type == T_BOOL) {
        return fail("\"%s\" is not a numeric field.", field_name ? field_name : "");
    }
    if (!field->writable) {
        return fail("\"%s\" is set by the engine and cannot be changed. Use a track kind to change mediatype.",
                    field->name);
    }
    if (isnan(value)) {
        return fail("\"%s\" needs a number.", field->name);
    }
    store_number(field, track, value);
    return 0;
}

/* Picks a name for a new file on the iPod (Music/F00 to F49) and returns its full path
 * under the mount point. Nothing is created. */
EMSCRIPTEN_KEEPALIVE
const char *ot_track_dest_path(const char *filename)
{
    clear_error();
    REQUIRE_DB(NULL);
    if (!filename || !*filename) {
        fail("A file name is required.");
        return NULL;
    }

    GError *error = NULL;
    gchar *path = itdb_cp_get_dest_filename(NULL, mountpoint, filename, &error);
    if (!path) {
        fail_from("Could not choose a place for the file", error);
        return NULL;
    }
    g_string_assign(out, path);
    g_free(path);
    return out->str;
}

/* What libgpod writes into a track when a file has been copied to the iPod, without
 * needing the file to exist where the engine runs (the app streams it to the real iPod). */
static const char *default_filetype(const char *suffix)
{
    static const struct { const char *suffix; const char *description; } KNOWN[] = {
        { "mp3", "MPEG audio file" },
        { "m4a", "AAC audio file" },
        { "m4b", "AAC audio file" },
        { "aac", "AAC audio file" },
        { "wav", "WAV audio file" },
        { "aif", "AIFF audio file" },
        { "aiff", "AIFF audio file" },
        { "m4v", "MPEG-4 video file" },
        { "mp4", "MPEG-4 video file" },
        { "mov", "MPEG-4 video file" },
    };
    for (gsize i = 0; i < G_N_ELEMENTS(KNOWN); i++) {
        if (g_ascii_strcasecmp(KNOWN[i].suffix, suffix) == 0) {
            return KNOWN[i].description;
        }
    }
    return NULL;
}

EMSCRIPTEN_KEEPALIVE
int ot_track_commit(int handle, const char *dest_path, double size_bytes)
{
    clear_error();
    REQUIRE_DB(-1);

    Itdb_Track *track = track_of(handle);
    if (!track) {
        return -1;
    }
    gsize mount_length = strlen(mountpoint);
    if (!dest_path || strlen(dest_path) <= mount_length || strncmp(dest_path, mountpoint, mount_length) != 0) {
        return fail("The file is not under the iPod's mount point.");
    }
    if (isnan(size_bytes) || size_bytes < 0 || size_bytes > (double) G_MAXUINT32) {
        return fail("The file size does not fit an iPod database entry.");
    }

    track->transferred = TRUE;
    track->size = (guint32) size_bytes;

    /* ipod_path starts with a separator and uses the iPod's own separator after that. */
    g_free(track->ipod_path);
    track->ipod_path = dest_path[mount_length] == G_DIR_SEPARATOR
                           ? g_strdup(&dest_path[mount_length])
                           : g_strdup_printf("%c%s", G_DIR_SEPARATOR, &dest_path[mount_length]);
    itdb_filename_fs2ipod(track->ipod_path);

    /* The first four letters of the suffix, upper case and space padded ("MP3 "). */
    const char *suffix = strrchr(dest_path, '.');
    suffix = suffix ? suffix + 1 : "";
    guint32 marker = 0;
    for (int i = 0; i < 4; i++) {
        marker = (marker << 8) | (guint32) ((gsize) i < strlen(suffix) ? g_ascii_toupper(suffix[i]) : ' ');
    }
    track->filetype_marker = marker;

    /* MP3 is type2 1 and AAC is 0 (libgpod's documentation). type1 marks VBR MP3 and is
     * left for the caller, who knows. */
    track->type2 = g_ascii_strcasecmp(suffix, "mp3") == 0 ? 1 : 0;

    if (!track->filetype || !*track->filetype) {
        const char *description = default_filetype(suffix);
        if (description) {
            g_free(track->filetype);
            track->filetype = g_strdup(description);
        }
    }
    track->time_modified = time(NULL);
    return 0;
}

EMSCRIPTEN_KEEPALIVE
int ot_track_remove(int handle)
{
    clear_error();
    REQUIRE_DB(-1);

    Itdb_Track *track = track_of(handle);
    if (!track) {
        return -1;
    }

    /* itdb_track_remove does not touch playlists, and a playlist that still points at a
     * freed track makes the next write abort. Take the track out of all of them first. */
    for (GList *p = db->playlists; p; p = p->next) {
        Itdb_Playlist *playlist = p->data;
        if (itdb_playlist_contains_track(playlist, track)) {
            itdb_playlist_remove_track(playlist, track);
        }
    }
    forget(&track_handles, track);
    itdb_track_remove(track);
    return 0;
}

/* Chapters mark positions inside an audiobook. libgpod starts the first one at 1 ms. */
EMSCRIPTEN_KEEPALIVE
int ot_track_add_chapter(int handle, double start_ms, const char *title)
{
    clear_error();
    REQUIRE_DB(-1);

    Itdb_Track *track = track_of(handle);
    if (!track) {
        return -1;
    }
    if (!track->chapterdata) {
        track->chapterdata = itdb_chapterdata_new();
    }
    if (isnan(start_ms) || start_ms < 0 || start_ms > (double) G_MAXUINT32) {
        return fail("The chapter start must be between 0 and about 49 days, in milliseconds.");
    }
    gchar *clean_title = g_utf8_make_valid(title ? title : "", -1);
    gboolean added = itdb_chapterdata_add_chapter(track->chapterdata, (guint32) start_ms, clean_title);
    g_free(clean_title);
    return added ? 0 : fail("Could not add the chapter.");
}

EMSCRIPTEN_KEEPALIVE
int ot_track_clear_chapters(int handle)
{
    clear_error();
    REQUIRE_DB(-1);

    Itdb_Track *track = track_of(handle);
    if (!track) {
        return -1;
    }
    if (track->chapterdata) {
        itdb_chapterdata_remove_chapters(track->chapterdata);
    }
    return 0;
}

/* ------------------------------------------------------------- playlists */

EMSCRIPTEN_KEEPALIVE
const char *ot_playlists_json(void)
{
    clear_error();
    REQUIRE_DB(NULL);

    g_string_truncate(out, 0);
    g_string_append_c(out, '[');
    for (GList *p = db->playlists; p; p = p->next) {
        Itdb_Playlist *playlist = p->data;
        if (p != db->playlists) {
            g_string_append_c(out, ',');
        }
        g_string_append_printf(out, "{\"handle\":%d,", handle_of(&playlist_handles, playlist));
        json_key(out, "name");
        json_optional_string(out, playlist->name);
        g_string_append_printf(out, ",\"master\":%s,\"podcasts\":%s,\"smart\":%s,\"tracks\":[",
                               itdb_playlist_is_mpl(playlist) ? "true" : "false",
                               itdb_playlist_is_podcasts(playlist) ? "true" : "false",
                               playlist->is_spl ? "true" : "false");
        for (GList *m = playlist->members; m; m = m->next) {
            if (m != playlist->members) {
                g_string_append_c(out, ',');
            }
            g_string_append_printf(out, "%d", handle_of(&track_handles, m->data));
        }
        g_string_append(out, "]}");
    }
    g_string_append_c(out, ']');
    return out->str;
}

EMSCRIPTEN_KEEPALIVE
int ot_playlist_create(const char *name)
{
    clear_error();
    REQUIRE_DB(-1);
    if (!name || !*name) {
        return fail("A playlist needs a name.");
    }

    gchar *clean_name = g_utf8_make_valid(name, -1);
    Itdb_Playlist *playlist = itdb_playlist_new(clean_name, FALSE);
    g_free(clean_name);
    itdb_playlist_add(db, playlist, -1);
    return handle_of(&playlist_handles, playlist);
}

EMSCRIPTEN_KEEPALIVE
int ot_playlist_rename(int handle, const char *name)
{
    clear_error();
    REQUIRE_DB(-1);

    Itdb_Playlist *playlist = playlist_of(handle);
    if (!playlist) {
        return -1;
    }
    if (!name || !*name) {
        return fail("A playlist needs a name.");
    }
    /* Renaming the master playlist renames the iPod itself. */
    g_free(playlist->name);
    playlist->name = g_utf8_make_valid(name, -1);
    return 0;
}

EMSCRIPTEN_KEEPALIVE
int ot_playlist_delete(int handle)
{
    clear_error();
    REQUIRE_DB(-1);

    Itdb_Playlist *playlist = playlist_of(handle);
    if (!playlist) {
        return -1;
    }
    if (itdb_playlist_is_mpl(playlist)) {
        return fail("The master playlist holds every track and cannot be deleted.");
    }
    if (itdb_playlist_is_podcasts(playlist)) {
        return fail("The podcast playlist is managed by track kinds and cannot be deleted.");
    }
    forget(&playlist_handles, playlist);
    itdb_playlist_remove(playlist);
    return 0;
}

EMSCRIPTEN_KEEPALIVE
int ot_playlist_add_track(int playlist_handle, int track_handle)
{
    clear_error();
    REQUIRE_DB(-1);

    Itdb_Playlist *playlist = playlist_of(playlist_handle);
    Itdb_Track *track = playlist ? track_of(track_handle) : NULL;
    if (!playlist || !track) {
        return -1;
    }
    if (!itdb_playlist_contains_track(playlist, track)) {
        itdb_playlist_add_track(playlist, track, -1);
    }
    return 0;
}

EMSCRIPTEN_KEEPALIVE
int ot_playlist_remove_track(int playlist_handle, int track_handle)
{
    clear_error();
    REQUIRE_DB(-1);

    Itdb_Playlist *playlist = playlist_of(playlist_handle);
    Itdb_Track *track = playlist ? track_of(track_handle) : NULL;
    if (!playlist || !track) {
        return -1;
    }
    if (itdb_playlist_is_mpl(playlist)) {
        return fail("Every track belongs to the master playlist. Remove the track itself instead.");
    }
    if (itdb_playlist_contains_track(playlist, track)) {
        itdb_playlist_remove_track(playlist, track);
    }
    return 0;
}

/* ------------------------------------------------------------- SQLite reader */

/* Apple's own library files can name collations and functions that only Apple's code
 * defines. Reading them here only counts and lists, so any ordering will do: a collation
 * SQLite asks for by name is answered with plain byte order, and the two sort helpers are
 * stand-ins that return their argument. They are marked deterministic because SQLite refuses
 * to read a file whose index uses a function that is not. */
static int compare_bytes(void *unused, int length_a, const void *a, int length_b, const void *b)
{
    (void) unused;
    int common = length_a < length_b ? length_a : length_b;
    int order = memcmp(a, b, (size_t) common);
    return order ? order : length_a - length_b;
}

static void on_collation_needed(void *unused, sqlite3 *handle, int encoding, const char *name)
{
    (void) unused;
    (void) encoding;
    sqlite3_create_collation(handle, name, SQLITE_UTF8, NULL, compare_bytes);
}

static void return_argument(sqlite3_context *context, int count, sqlite3_value **values)
{
    (void) count;
    sqlite3_result_value(context, values[0]);
}

/* Integers a JavaScript number cannot hold exactly (the iPod's 64-bit persistent ids) are
 * written as strings. */
static void json_sqlite_value(GString *s, sqlite3_stmt *statement, int column)
{
    switch (sqlite3_column_type(statement, column)) {
    case SQLITE_INTEGER: {
        sqlite3_int64 value = sqlite3_column_int64(statement, column);
        if (value > 9007199254740991LL || value < -9007199254740991LL) {
            g_string_append_printf(s, "\"%lld\"", (long long) value);
        } else {
            g_string_append_printf(s, "%lld", (long long) value);
        }
        break;
    }
    case SQLITE_FLOAT: {
        double value = sqlite3_column_double(statement, column);
        if (isfinite(value)) {
            g_string_append_printf(s, "%.17g", value);
        } else {
            g_string_append(s, "null");
        }
        break;
    }
    case SQLITE_TEXT:
        json_string(s, (const gchar *) sqlite3_column_text(statement, column));
        break;
    case SQLITE_BLOB: {
        gchar *label = g_strdup_printf("<blob, %d bytes>", sqlite3_column_bytes(statement, column));
        json_string(s, label);
        g_free(label);
        break;
    }
    default:
        g_string_append(s, "null");
    }
}

/* Runs one query on an SQLite file, read only, and returns
 *   {"columns":[...],"rows":[[...],...],"truncated":false}
 * Reading stops after max_rows rows and says so. The file is opened afresh for each call. */
EMSCRIPTEN_KEEPALIVE
const char *ot_sqlite_query_json(const char *path, const char *query, int max_rows)
{
    clear_error();
    if (!path || !*path || !query || !*query) {
        fail("A database path and a query are required.");
        return NULL;
    }
    if (max_rows <= 0) {
        max_rows = 1000;
    }

    sqlite3 *handle = NULL;
    if (sqlite3_open_v2(path, &handle, SQLITE_OPEN_READONLY, NULL) != SQLITE_OK) {
        fail("Could not open %s: %s", path, handle ? sqlite3_errmsg(handle) : "out of memory");
        sqlite3_close(handle);
        return NULL;
    }
    sqlite3_collation_needed(handle, NULL, on_collation_needed);
    sqlite3_create_function(handle, "iPhoneSortKey", 1, SQLITE_UTF8 | SQLITE_DETERMINISTIC, NULL, return_argument, NULL, NULL);
    sqlite3_create_function(handle, "iPhoneSortSection", 1, SQLITE_UTF8 | SQLITE_DETERMINISTIC, NULL, return_argument, NULL, NULL);

    sqlite3_stmt *statement = NULL;
    if (sqlite3_prepare_v2(handle, query, -1, &statement, NULL) != SQLITE_OK) {
        fail("Could not read %s: %s", path, sqlite3_errmsg(handle));
        sqlite3_close(handle);
        return NULL;
    }

    g_string_truncate(out, 0);
    g_string_append(out, "{\"columns\":[");
    int columns = sqlite3_column_count(statement);
    for (int c = 0; c < columns; c++) {
        if (c) {
            g_string_append_c(out, ',');
        }
        json_string(out, sqlite3_column_name(statement, c));
    }
    g_string_append(out, "],\"rows\":[");

    int rows = 0;
    gboolean truncated = FALSE;
    int status;
    while ((status = sqlite3_step(statement)) == SQLITE_ROW) {
        if (rows >= max_rows) {
            truncated = TRUE;
            break;
        }
        if (rows) {
            g_string_append_c(out, ',');
        }
        g_string_append_c(out, '[');
        for (int c = 0; c < columns; c++) {
            if (c) {
                g_string_append_c(out, ',');
            }
            json_sqlite_value(out, statement, c);
        }
        g_string_append_c(out, ']');
        rows++;
    }

    if (status != SQLITE_ROW && status != SQLITE_DONE) {
        fail("Could not read %s: %s", path, sqlite3_errmsg(handle));
        sqlite3_finalize(statement);
        sqlite3_close(handle);
        return NULL;
    }
    g_string_append_printf(out, "],\"truncated\":%s}", truncated ? "true" : "false");
    sqlite3_finalize(statement);
    sqlite3_close(handle);
    return out->str;
}
