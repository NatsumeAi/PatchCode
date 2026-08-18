import fs from "node:fs"
import os from "node:os"
import path from "path"

process.env.OPENCODE_DB = ":memory:"
process.env.BUN_TEST = "1"
process.env.OPENCODE_MODELS_PATH = path.join(import.meta.dir, "plugin", "fixtures", "models-dev.json")
process.env.OPENCODE_DISABLE_MODELS_FETCH = "true"

const testHome = path.join(os.tmpdir(), `opencode-core-home-${process.pid}`)
fs.mkdirSync(testHome, { recursive: true })
process.env.OPENCODE_TEST_HOME = testHome
