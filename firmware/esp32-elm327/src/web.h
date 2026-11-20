// HTTP server: login, phase-1 API, Server-Sent Events, captive redirects.
#pragma once
#include "settings.h"

namespace web {

void begin(Settings* settings);
void loop();              // call often from the Arduino loop (SSE, restarts)

}  // namespace web
