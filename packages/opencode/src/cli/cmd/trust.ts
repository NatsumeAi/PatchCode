import type { Argv } from "yargs"
import { Trust } from "@opencode-ai/core/trust"
import { cmd } from "./cmd"

export const TrustCommand = cmd({
  command: "trust [dir]",
  describe: "trust a folder so project hooks, exec-policy, and sandbox.toml can load",
  builder: (yargs: Argv) =>
    yargs.positional("dir", {
      type: "string",
      describe: "directory to trust (default: cwd)",
    }),
  handler: async (args) => {
    const granted = await Trust.grant(String(args.dir ?? process.cwd()))
    process.stdout.write(`trusted ${granted}\n`)
  },
})
