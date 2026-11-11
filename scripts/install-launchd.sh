#!/bin/sh
# Builds the voice helper and installs tvctl-agent as a launchd agent that starts at login.
# Usage: scripts/install-launchd.sh [uninstall]
set -eu
cd "$(dirname "$0")/.."
repo=$(pwd)
label=io.github.yusukeshib.tvctl-agent
plist="$HOME/Library/LaunchAgents/$label.plist"
logdir="$HOME/Library/Logs/tvctl-agent"

if [ "${1:-}" = uninstall ]; then
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  rm -f "$plist"
  echo "uninstalled $label"
  exit 0
fi

node=$(command -v node)
tvctl=$(command -v tvctl)
(cd voice && swift build -c release)
npm ci --silent
mkdir -p "$logdir" "$HOME/.config/tvctl-agent" "$HOME/Library/LaunchAgents"
[ -f "$HOME/.config/tvctl-agent/config.toml" ] || cp config.example.toml "$HOME/.config/tvctl-agent/config.toml"

cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array><string>$node</string><string>$repo/src/main.ts</string></array>
  <key>WorkingDirectory</key><string>$repo</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$tvctl"):$(dirname "$node"):/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$logdir/agent.log</string>
  <key>StandardErrorPath</key><string>$logdir/agent.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"
echo "installed $label; log: $logdir/agent.log; config: ~/.config/tvctl-agent/config.toml"
