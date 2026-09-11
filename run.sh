#!/bin/sh
# Local `dsh web` launcher.
#
# The heap ceiling is explicit so `session-controller heap watermark` has a
# ceiling to report against; the default 4 GB is a Node default, not a policy.
#
# Do NOT add `--heapsnapshot-near-heap-limit` here. V8 builds the snapshot graph
# synchronously on the main thread before it streams anything, so at a
# multi-gigabyte heap the process stops answering HTTP for as long as the graph
# takes to build — and the graph itself costs multiples of the heap. A near-limit
# capture therefore turns a crash that leaves a FATAL ERROR and a watermark curve
# into an unbounded stall that leaves neither. Capture a snapshot deliberately
# (from a live inspector session, or with a small heap in a reproduction).
NODE_OPTIONS="--max-old-space-size=12288" pnpm dsh web
