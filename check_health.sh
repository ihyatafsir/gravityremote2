#!/bin/bash
# Antigravity & GravityRemote Health Check Script

echo "--- [System Load] ---"
uptime
cat /proc/loadavg

echo -e "\n--- [Top CPU Hogs] ---"
ps -eo %cpu,pid,comm --sort=-%cpu | head -n 8

echo -e "\n--- [Inotify Watches] ---"
LIMIT=$(cat /proc/sys/fs/inotify/max_user_watches)
echo "Current Limit: $LIMIT"
if [ "$LIMIT" -lt 524288 ]; then
    echo "⚠️ WARNING: Inotify limit is low. Recommended: 524288"
else
    echo "✅ Inotify limit is healthy."
fi

echo -e "\n--- [Failing Services] ---"
FAILED=$(systemctl --failed --quiet && echo "Found" || echo "None")
if [ "$FAILED" == "Found" ]; then
    systemctl --failed --no-legend
else
    echo "✅ No failing system services."
fi

echo -e "\n--- [GravityRemote Server] ---"
LSOF=$(lsof -i :3000 -t)
if [ -n "$LSOF" ]; then
    echo "✅ Server running on PID $LSOF"
else
    echo "❌ Server is NOT running on port 3000."
fi
