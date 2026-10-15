# CIMDA k3s storage on data2

Active k3s storage belongs under:
 /home/data2/zelinrick/nautilus/k3s-host

The three existing host paths are bind mounts so Kubernetes volume paths remain
stable:
- data -> /var/lib/rancher/k3s
- kubelet -> /var/lib/kubelet
- pod-logs -> /var/log/pods

migrate-to-data2.sh is a one-time host-root migration tool. --check measures the
source and requires sufficient destination space to leave 16% free, plus a 512 MiB
copy margin. --execute stops k3s and its containers, copies the data with numeric
ownership, ACLs and extended attributes, checks file contents with rsync, compares
the SQLite database and server token, updates only the three /etc/fstab entries,
and starts k3s. It preserves the original source and attempts rollback on failure.

The installed k3s-killall.sh is copied for use during the stop. Its command that
clears unrelated Tailscale advertised routes is replaced with a no-op. This
preserves Tailscale settings while stopping Kubernetes containers and cleaning up
their mounts and CNI state.

The migration is launched as a transient host systemd unit from a temporary
Kubernetes node-maintenance pod. It continues after k3s and the launcher stop.

## Model cleanup

At the user's request, nine GGUF files were removed from the disabled CIMDA Qwen
Flash Next model PVC, freeing approximately 182 GiB. These included the original
UD-IQ3_XXS model, the abliterated UD-Q4_K_XL model and their vision projectors.
Obsolete .verified-* markers were also removed.

The PVC remains Bound and the deployment remains at zero replicas. Reusing that
deployment requires downloading and verifying the model files again. Its existing
completed download Jobs do not rerun automatically. The separate engine benchmark
volume is retained.

## Inspection

On CIMDA:

~~~sh
findmnt -T /var/lib/rancher/k3s -o TARGET,SOURCE,FSROOT
findmnt -T /var/lib/kubelet -o TARGET,SOURCE,FSROOT
findmnt -T /var/log/pods -o TARGET,SOURCE,FSROOT
df -h /home/data2
systemctl status k3s --no-pager
cat /home/data2/zelinrick/nautilus/k3s-storage-migration/migration-status.log
kubectl get nodes
kubectl -n monitoring get deployment,statefulset,pvc
~~~

Configuration backups, private copy-check logs and status are under
/home/data2/zelinrick/nautilus/k3s-storage-migration/run-<UTC timestamp>.
The latest-run file records the run directory. A SUCCESS file records completion.
The original /home/data/k3s-host data is retained as a rollback source.

The script rejects already-migrated hosts. A staging directory can be resumed only
when its origin marker and server token match the original cluster.
Any manual rollback requires host administrator access and a fresh backup of the
current database and volumes before replacing state.

References:
- [K3s backup and restore](https://docs.k3s.io/datastore/backup-restore)
- [Stopping K3s containers](https://docs.k3s.io/upgrades/killall)
- [Kubernetes node maintenance](https://kubernetes.io/docs/tasks/debug/debug-cluster/kubectl-node-debug/)

## Verified result

The migration completed on 2026-10-15 UTC. All three active host paths use
/dev/nvme3n1p2 under /home/data2/zelinrick/nautilus/k3s-host. Data2 has about
151 GiB free, and the node reports DiskPressure=False.

The old data bind could not detach after k3s stopped. The script retains it
underneath the new data2 bind until reboot; the active directory's device and
inode are checked against the destination. The new /etc/fstab entries use data2,
so a future normal boot mounts data2 directly. The original source remains
available for rollback.

Prometheus and Grafana are Ready, both GPU scrape targets are UP, all seven GPU
metrics contain six GPUs, and Grafana returns six GPU data frames. GPU history
from 2026-10-14 11:00 UTC was queried successfully for all six GPUs.

The MagicDNS dashboard returned HTTP 200:
http://cimda0728-tower/grafana/d/gpu-usage/gpu-usage

Validation included bash -n, capacity preflight, full content comparison after
copying, SQLite/token comparison, exact bind-directory identity, Kubernetes
readyz, node pressure and runtime filesystem statistics, live Prometheus and
Grafana queries, and a pre-migration historical query.
