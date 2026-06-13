#!/bin/bash
if [[ "$1" == "build" || "$1" == "check" || "$1" == "run" || "$1" == "update" ]]; then
  exec ~/.cargo/bin/cargo "$@" --ignore-rust-version
else
  exec ~/.cargo/bin/cargo "$@"
fi
