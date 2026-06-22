#!/usr/bin/env bun
// Entry point for the compiled standalone binary (build/build-binary.sh → `bun build --compile`).
// server.js only auto-starts when run directly as a script (its import.meta entry guard), which
// never matches inside a compiled bundle — so the binary starts the server explicitly here.
import { listen } from './server.js'

listen(Number(process.env.PORT) || 8765)
