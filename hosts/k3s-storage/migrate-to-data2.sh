#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export LC_ALL=C
destination=/home/data2/zelinrick/nautilus/k3s-host
workspace=/home/data2/zelinrick/nautilus/k3s-storage-migration
old_base=/home/data/k3s-host
die() { echo "ERROR: $*" >&2; exit 1; }
target_for() {
  case "$1" in
    data) echo /var/lib/rancher/k3s ;;
    kubelet) echo /var/lib/kubelet ;;
    pod-logs) echo /var/log/pods ;;
    *) return 1 ;;
  esac
}
[[ $EUID == 0 ]] || die "Run as host root."
[[ $# == 1 ]] || die "Use --check or --execute."
mode=$1
[[ $mode == --check || $mode == --execute ]] || die "Use --check or --execute."
for tool in rsync findmnt mount umount systemctl awk du df flock cmp; do
  command -v "$tool" >/dev/null || die "Missing required tool: $tool"
done
[[ $(findmnt -n -o TARGET -T /home/data2) == /home/data2 ]] || die "data2 is not mounted."
[[ $(findmnt -n -o SOURCE -T "$workspace") != $(findmnt -n -o SOURCE -T /home/data) ]] ||
  die "Destination is still on the old filesystem."
for part in data kubelet pod-logs; do
  target=$(target_for "$part")
  mountpoint -q "$target" || die "$target is not a mount point."
  [[ $(findmnt -n -o FSROOT -T "$target") == "/k3s-host/$part" ]] ||
    die "Unexpected source for $target"
  awk -v src="$old_base/$part" -v dst="$target" \
    '$1==src && $2==dst {found++} END {exit found!=1}' /etc/fstab ||
    die "Expected exactly one old fstab entry for $target"
done
[[ -f /var/lib/rancher/k3s/server/db/state.db ]] || die "Expected SQLite datastore was not found."
staged_bytes=0
if [[ -d "$destination" ]] && find "$destination" -mindepth 1 -print -quit | grep -q .; then
  [[ -f "$destination/.migration-origin" ]] || die "Unrecognized nonempty destination."
  grep -qxF "$old_base" "$destination/.migration-origin" || die "Staging origin mismatch."
  cmp /var/lib/rancher/k3s/server/token "$destination/data/server/token" ||
    die "Staged cluster identity does not match."
  staged_bytes=$(du -sx --block-size=1 "$destination" | awk '{print $1}')
fi
total_bytes=$(du -sx --block-size=1 /var/lib/rancher/k3s /var/lib/kubelet /var/log/pods |
  awk '{n+=$1} END {printf "%.0f\n",n}')
available=$(df -B1 --output=avail "$workspace" | awk 'NR==2 {print $1}')
capacity=$(df -B1 --output=size "$workspace" | awk 'NR==2 {print $1}')
reserve=$((capacity * 16 / 100))
pending_bytes=$((total_bytes - staged_bytes))
(( pending_bytes >= 0 )) || pending_bytes=0
required=$((pending_bytes + reserve + 536870912))
printf 'Source bytes: %s\nDestination available bytes: %s\nRequired bytes including 16%% reserve: %s\n' \
  "$total_bytes" "$available" "$required"
(( available >= required )) || die "Insufficient data2 headroom."
[[ $mode == --execute ]] || exit 0

mkdir -p "$workspace"
exec 9>"$workspace/migration.lock"
flock -n 9 || die "Another migration is running."
run_dir="$workspace/run-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -m 700 "$run_dir"
touch "$workspace/migration-status.log"
chmod 644 "$workspace/migration-status.log"
exec > >(tee -a "$workspace/migration-status.log" "$run_dir/migration.log") 2>&1
echo "$run_dir" > "$workspace/latest-run"
chmod 644 "$workspace/latest-run"
cp -a /etc/fstab "$run_dir/fstab.before"
for part in data kubelet pod-logs; do mkdir -p "$destination/$part"; done
printf '%s\n' "$old_base" > "$destination/.migration-origin"
findmnt -R /var/lib/rancher/k3s > "$run_dir/k3s-mounts.before"
findmnt -R /var/lib/kubelet > "$run_dir/kubelet-mounts.before"
findmnt -R /var/log/pods > "$run_dir/log-mounts.before"

stopped=0
fstab_changed=0
success=0
rollback() {
  code=$?
  trap - EXIT
  if (( success == 0 && stopped == 1 )); then
    echo "Migration failed (exit $code); restoring original mounts."
    /bin/sh "$run_dir/stop-containers.sh" >> "$run_dir/rollback-stop.log" 2>&1 || true
    for part in pod-logs kubelet data; do
      target=$(target_for "$part")
      current=$(stat -Lc '%d:%i' "$target" 2>/dev/null || true)
      expected=$(stat -Lc '%d:%i' "$destination/$part" 2>/dev/null || true)
      if [[ $current == "$expected" ]]; then umount "$target" || true; fi
    done
    if (( fstab_changed == 1 )); then
      cp -a "$run_dir/fstab.before" /etc/fstab
      systemctl daemon-reload
    fi
    for part in data kubelet pod-logs; do
      target=$(target_for "$part")
      if [[ $(stat -Lc '%d:%i' "$target") != $(stat -Lc '%d:%i' "$old_base/$part") ]]; then
        mount --bind "$old_base/$part" "$target"
      fi
    done
    systemctl start k3s || true
    echo "Rollback attempted. Review $run_dir/migration.log."
  fi
  exit "$code"
}
trap rollback EXIT

# Preserve unrelated Tailscale subnet-route settings during K3s cleanup.
sed 's/^[[:space:]]*tailscale set --advertise-routes=$/        : # Preserve Tailscale routes/' \
  /usr/local/bin/k3s-killall.sh > "$run_dir/stop-containers.sh"
chmod 700 "$run_dir/stop-containers.sh"
stopped=1
/bin/sh "$run_dir/stop-containers.sh" > "$run_dir/stop-containers.log" 2>&1 || true
# KillMode=process can leave child daemons holding the old mount.
systemctl kill --kill-who=all --signal=SIGKILL k3s.service 2>/dev/null || true
sleep 2
fuser -vm /var/lib/rancher/k3s > "$workspace/mount-users.log" 2>&1 || true
chmod 644 "$workspace/mount-users.log"
! systemctl is-active --quiet k3s || die "K3s did not stop."
findmnt -rn -o TARGET | grep -E '^/var/lib/(rancher/k3s|kubelet)/.+|^/var/log/pods/.+' > "$run_dir/remaining-mounts" || true
[[ ! -s "$run_dir/remaining-mounts" ]] ||
  die "Child mounts remain after stopping K3s; refusing to copy live mounts."

# Leave the source untouched for rollback; copy only after all writers stop.
for part in data kubelet pod-logs; do
  target=$(target_for "$part")
  rsync -aHAXx --numeric-ids --delete "$target/" "$destination/$part/"
  rsync -aHAXxnc --numeric-ids --delete --itemize-changes "$target/" "$destination/$part/" \
    > "$run_dir/$part-copy-check"
  [[ ! -s "$run_dir/$part-copy-check" ]] || die "Content verification failed for $part"
done
cmp /var/lib/rancher/k3s/server/db/state.db "$destination/data/server/db/state.db"
cmp /var/lib/rancher/k3s/server/token "$destination/data/server/token"
sync

awk -v old="$old_base" -v new="$destination" '
  $1==old "/data" && $2=="/var/lib/rancher/k3s" {
    print new "/data /var/lib/rancher/k3s none bind,x-systemd.requires-mounts-for=/home/data2 0 0"; next
  }
  $1==old "/kubelet" && $2=="/var/lib/kubelet" {
    print new "/kubelet /var/lib/kubelet none bind,x-systemd.requires-mounts-for=/home/data2 0 0"; next
  }
  $1==old "/pod-logs" && $2=="/var/log/pods" {
    print new "/pod-logs /var/log/pods none bind,x-systemd.requires-mounts-for=/home/data2 0 0"; next
  }
  {print}
' /etc/fstab > "$run_dir/fstab.after"
findmnt --verify --tab-file "$run_dir/fstab.after"
for part in pod-logs kubelet data; do
  target=$(target_for "$part")
  if ! umount "$target" 2> "$run_dir/umount-$part.log"; then
    [[ $part == data ]] && grep -q 'target is busy' "$run_dir/umount-$part.log" ||
      die "Failed to detach $target"
    echo "Preserving busy old data bind underneath the new bind until reboot."
  fi
done
fstab_changed=1
install -m 644 "$run_dir/fstab.after" /etc/fstab
systemctl daemon-reload
for part in data kubelet pod-logs; do
  target=$(target_for "$part")
  mount --bind "$destination/$part" "$target"
  [[ $(stat -Lc '%d:%i' "$target") == $(stat -Lc '%d:%i' "$destination/$part") ]] ||
    die "Wrong directory mounted at $target"
done
systemctl start k3s
api_ready=0
for attempt in $(seq 1 50); do
  if /usr/local/bin/kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml get --raw=/readyz \
      > "$run_dir/api-readyz" 2>/dev/null; then
    api_ready=1
    break
  fi
  sleep 2
done
(( api_ready == 1 )) || die "Kubernetes API did not become ready."
success=1
echo "Migration completed successfully."
findmnt -T /var/lib/rancher/k3s -o TARGET,SOURCE,FSROOT
findmnt -T /var/lib/kubelet -o TARGET,SOURCE,FSROOT
findmnt -T /var/log/pods -o TARGET,SOURCE,FSROOT
df -h /home/data2
touch "$run_dir/SUCCESS"

