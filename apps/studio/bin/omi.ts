#!/usr/bin/env bun
import { main } from "../src/cli";

process.exit(await main(process.argv.slice(2)));
