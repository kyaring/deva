#!/bin/sh
# 生产用单文件二进制：先用 esbuild 生成自包含 bundle，再由固定版本的 bun 编译为原生可执行文件（内含 bun 运行时，目标机器不需要 Node）。
set -eu
cd "$(dirname "$0")/.."
node scripts/build-headless.mjs
pnpm exec bun build --compile out/headless/deva-headless.cjs --outfile out/headless/deva-headless
echo "built out/headless/deva-headless ($(pnpm exec bun --version))"
