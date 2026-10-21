#!/bin/bash
# Installs the monitoring check (etg-monitor-check) on a VM. Run as root.
#
#   sudo bash install.sh monitoring   # staging VM: targets, ports, promtail
#   sudo bash install.sh agent        # prod VM: ports, promtail
#
# The healthchecks.io ping URL is asked for on a terminal, or taken from
# ETG_MONITOR_HC_URL when there is none. Safe to re-run: an existing
# /etc/etg-monitor-check/config.env is kept; delete it to start over.
set -Eeuo pipefail
umask 077

role=${1:?usage: install.sh monitoring|agent}
here=$(cd "$(dirname "$0")" && pwd)
config_dir=/etc/etg-monitor-check

case "$role" in
    monitoring) checks=targets,ports,promtail; promtail=monitoring-promtail-1 ;;
    agent) checks=ports,promtail; promtail=etg-agent-promtail-1 ;;
    *) echo "Unknown role: $role (monitoring or agent)" >&2; exit 1 ;;
esac

[[ $(id -u) -eq 0 ]] || { echo "Run as root." >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required." >&2; exit 1; }

install -d -m 0700 "$config_dir"
if [[ ! -s "$config_dir/config.env" ]]; then
    hc_url=${ETG_MONITOR_HC_URL:-}
    if [[ -z "$hc_url" && -t 0 ]]; then
        read -rp "healthchecks.io ping URL for this VM: " hc_url
    fi
    [[ "$hc_url" == https://* ]] || { echo "A https:// ping URL is required." >&2; exit 1; }
    cat > "$config_dir/config.env" <<CONF
# etg-monitor-check settings (KEY=VALUE, no quotes). See the script header.
ETG_MONITOR_HC_URL=$hc_url
ETG_MONITOR_CHECKS=$checks
ETG_MONITOR_PROMTAIL_CONTAINERS=$promtail
# Containers that may run without their published ports, comma-separated.
ETG_MONITOR_IGNORE_CONTAINERS=
CONF
    chmod 0600 "$config_dir/config.env"
fi

install -m 0755 "$here/etg-monitor-check" /usr/local/sbin/etg-monitor-check
install -m 0644 "$here/etg-monitor-check.service" /etc/systemd/system/etg-monitor-check.service
install -m 0644 "$here/etg-monitor-check.timer" /etc/systemd/system/etg-monitor-check.timer
systemctl daemon-reload
systemctl enable --now etg-monitor-check.timer

/usr/local/sbin/etg-monitor-check --dry-run
echo "Installed. First report within 5 minutes; a new problem is reported on the run after it appears."
