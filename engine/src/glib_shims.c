/*
 * Shims for symbols the emscripten build of glib references but does not define.
 *
 * The emscripten patch series for glib leaves out giounix.c, yet gtestutils.c
 * (pulled in by every g_assert) still calls g_io_channel_unix_new. Found by
 * test-linking glib, gobject and gmodule in strict mode: this is the only
 * unresolved symbol.
 *
 * Nothing in the engine uses glib's test framework or unix IO channels, so the
 * shim returns NULL. If it is ever reached, the caller gets a clear NULL
 * instead of a link error.
 */

#include <glib.h>

GIOChannel *g_io_channel_unix_new(gint fd)
{
    (void) fd;
    return NULL;
}
