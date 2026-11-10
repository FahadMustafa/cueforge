/** `cueforge` entry point: wires {@link run} to the real process and file system. */
import { nodeIo, run } from './cli';

process.exitCode = await run(
  process.argv.slice(2),
  nodeIo(
    (line) => process.stdout.write(`${line}\n`),
    (line) => process.stderr.write(`${line}\n`),
  ),
);
