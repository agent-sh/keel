#!/usr/bin/env bash
# A KEEL_NOTIFY_COMMAND for e2e: appends the alert JSON to $KEEL_NOTIFY_LOG.
# Start the daemon with KEEL_NOTIFY_COMMAND=<this file> and KEEL_NOTIFY_LOG=<file>,
# and run the alerts spec with the same KEEL_NOTIFY_LOG.
printf '%s\n' "$1" >> "${KEEL_NOTIFY_LOG:?KEEL_NOTIFY_LOG is not set}"
