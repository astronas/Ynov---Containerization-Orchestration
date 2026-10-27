/* Simulateur, Kubernetes : un cluster Minikube d'un nœud. Contrôleurs (Deployment, ReplicaSet, Service,
 * EndpointSlice, PVC), pods exécutés comme des conteneurs du nœud, DNS du cluster, port-forward,
 * et les commandes kubectl et minikube, au format des sorties réelles de kubectl 1.37 et minikube 1.39. */
(function (G) {
  "use strict";
  const SIM = G.SIM; const O = SIM.outils; const R = SIM.R; const H = SIM.horloge; const chemin = SIM.chemin; const D = SIM.docker;
  const IP_NOEUD = "192.168.49.2";
  const ALPHA = "bcdfghjklmnpqrstvwxz2456789";
  const suffixe = (n = 5) => Array.from({ length: n }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join("");
  const uuid = () => `${O.hex(8)}-${O.hex(4)}-${O.hex(4)}-${O.hex(4)}-${O.hex(12)}`;
  const yaml = () => G.jsyaml;
  const iso = (t) => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");
  const clone = (o) => JSON.parse(JSON.stringify(o));

  // Âge façon kubectl (duration.HumanDuration).
  function age(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 0) return "0s";
    if (s < 120) return s + "s";
    const m = Math.floor(s / 60);
    if (m < 10) return s % 60 ? `${m}m${s % 60}s` : `${m}m`;
    if (m < 180) return m + "m";
    const h = Math.floor(m / 60);
    if (h < 8) return m % 60 ? `${h}h${m % 60}m` : `${h}h`;
    if (h < 48) return h + "h";
    if (h < 192) return h % 24 ? `${Math.floor(h / 24)}d${h % 24}h` : `${Math.floor(h / 24)}d`;
    return Math.floor(h / 24) + "d";
  }

  /* --------------------------------------------------------- types d'objets */
  const TYPES = [
    { res: "pods", kind: "Pod", api: "v1", noms: ["po", "pod", "pods"], prefixe: "pod", groupe: "pods" },
    { res: "deployments", kind: "Deployment", api: "apps/v1", noms: ["deploy", "deployment", "deployments"], prefixe: "deployment.apps", groupe: "deployments.apps" },
    { res: "replicasets", kind: "ReplicaSet", api: "apps/v1", noms: ["rs", "replicaset", "replicasets"], prefixe: "replicaset.apps", groupe: "replicasets.apps" },
    { res: "services", kind: "Service", api: "v1", noms: ["svc", "service", "services"], prefixe: "service", groupe: "services" },
    { res: "endpointslices", kind: "EndpointSlice", api: "discovery.k8s.io/v1", noms: ["endpointslice", "endpointslices"], prefixe: "endpointslice.discovery.k8s.io", groupe: "endpointslices.discovery.k8s.io" },
    { res: "configmaps", kind: "ConfigMap", api: "v1", noms: ["cm", "configmap", "configmaps"], prefixe: "configmap", groupe: "configmaps" },
    { res: "secrets", kind: "Secret", api: "v1", noms: ["secret", "secrets"], prefixe: "secret", groupe: "secrets" },
    { res: "persistentvolumeclaims", kind: "PersistentVolumeClaim", api: "v1", noms: ["pvc", "persistentvolumeclaim", "persistentvolumeclaims"], prefixe: "persistentvolumeclaim", groupe: "persistentvolumeclaims" },
    { res: "persistentvolumes", kind: "PersistentVolume", api: "v1", noms: ["pv", "persistentvolume", "persistentvolumes"], prefixe: "persistentvolume", groupe: "persistentvolumes", global: true },
    { res: "namespaces", kind: "Namespace", api: "v1", noms: ["ns", "namespace", "namespaces"], prefixe: "namespace", groupe: "namespaces", global: true },
    { res: "nodes", kind: "Node", api: "v1", noms: ["no", "node", "nodes"], prefixe: "node", groupe: "nodes", global: true },
    { res: "ingresses", kind: "Ingress", api: "networking.k8s.io/v1", noms: ["ing", "ingress", "ingresses"], prefixe: "ingress.networking.k8s.io", groupe: "ingresses.networking.k8s.io" },
    { res: "events", kind: "Event", api: "v1", noms: ["ev", "event", "events"], prefixe: "event", groupe: "events" },
  ];
  const typeDe = (n) => TYPES.find((t) => t.noms.includes(String(n).toLowerCase()) || t.kind.toLowerCase() === String(n).toLowerCase() || t.groupe === String(n).toLowerCase());
  const typeKind = (k) => TYPES.find((t) => t.kind === k);

  /* ----------------------------------------------------------- le cluster */
  class Cluster {
    constructor(hote) {
      this.hote = hote; this.etat = "Stopped"; this.creeA = H.now() - (5 * 86400 + 20 * 3600) * 1000;
      this.demarreA = null; this.objets = []; this.ipPod = 18; this.imagesTirees = new Set(["registry.k8s.io/pause:3.10"]);
      this.addons = { "storage-provisioner": true, "default-storageclass": true, dashboard: true, "metrics-server": true };
      this.forwards = []; this.version = 39000;
      this.noeud = new D.Moteur(hote, { secondaire: true });
      this.noeud.creerReseau("k8s", { sousReseau: "10.244.0" });
      // Le nœud Minikube est un conteneur Docker de l'hôte, arrêté au départ.
      const m = hote.m;
      const r = D.Moteur.ref("gcr.io/k8s-minikube/kicbase:v0.0.51");
      const im = m.imageDeBase(r); im.cree = this.creeA - 86400000; m.images.set(r.ref, im);
      m.creerReseau("minikube", { sousReseau: "192.168.49" });
      const ports = [["22", "32768"], ["2376", "32769"], ["5000", "32770"], ["8443", "32771"], ["32443", "32772"]].map(([ctn, hote2]) => ({ ip: "127.0.0.1", hote: hote2, ctn, proto: "tcp" }));
      const c = m.creer(im, { nom: "minikube", imageTapee: "gcr.io/k8s-minikube/kicbase:v0.0.51", ports, reseau: "minikube", hostname: "minikube", privileged: true, labels: { "created_by.minikube.sigs.k8s.io": "true", "name.minikube.sigs.k8s.io": "minikube" } });
      c.cree = this.creeA; c.etat = "exited"; c.code = 130; c.finit = H.now() - 3600000;
      this.kic = c;
      // Objets du système.
      ["default", "kube-node-lease", "kube-public", "kube-system", "kubernetes-dashboard"].forEach((n) => this.ajouterNs(n, this.creeA));
      this.ajouter({ apiVersion: "v1", kind: "Service", metadata: { name: "kubernetes", namespace: "default", labels: { component: "apiserver", provider: "kubernetes" } }, spec: { type: "ClusterIP", clusterIP: "10.96.0.1", ports: [{ name: "https", port: 443, protocol: "TCP", targetPort: 8443 }] } }, this.creeA);
      this.ajouter({ apiVersion: "v1", kind: "Service", metadata: { name: "kube-dns", namespace: "kube-system", labels: { "k8s-app": "kube-dns" } }, spec: { type: "ClusterIP", clusterIP: "10.96.0.10", selector: { "k8s-app": "kube-dns" }, ports: [{ name: "dns", port: 53, protocol: "UDP", targetPort: 53 }, { name: "dns-tcp", port: 53, protocol: "TCP", targetPort: 53 }] } }, this.creeA);
      [["coredns-7c65d6cfc9-" + suffixe(), "registry.k8s.io/coredns/coredns:v1.12.1"], ["etcd-minikube", "registry.k8s.io/etcd:3.6.4-0"], ["kube-apiserver-minikube", "registry.k8s.io/kube-apiserver:v1.37.0"],
        ["kube-controller-manager-minikube", "registry.k8s.io/kube-controller-manager:v1.37.0"], ["kube-proxy-" + suffixe(), "registry.k8s.io/kube-proxy:v1.37.0"], ["kube-scheduler-minikube", "registry.k8s.io/kube-scheduler:v1.37.0"],
        ["metrics-server-85b7d694d7-" + suffixe(), "registry.k8s.io/metrics-server/metrics-server:v0.9.0"], ["storage-provisioner", "gcr.io/k8s-minikube/storage-provisioner:v5"]]
        .forEach(([n, img]) => { const p = this.ajouter({ apiVersion: "v1", kind: "Pod", metadata: { name: n, namespace: "kube-system", labels: {} }, spec: { containers: [{ name: n.split("-")[0], image: img }], nodeName: "minikube" } }, this.creeA); p.systeme = true; p.status = { phase: "Running", podIP: n.startsWith("coredns") || n.startsWith("metrics") ? "10.244.0." + (2 + Math.floor(Math.random() * 3)) : IP_NOEUD }; p.pret = this.creeA; });
      [["dashboard-metrics-scraper-5d59dccf9b-" + suffixe(), "docker.io/kubernetesui/metrics-scraper:v1.0.8"], ["kubernetes-dashboard-7779f9b69b-" + suffixe(), "docker.io/kubernetesui/dashboard:v2.7.0"]]
        .forEach(([n, img]) => { const p = this.ajouter({ apiVersion: "v1", kind: "Pod", metadata: { name: n, namespace: "kubernetes-dashboard", labels: {} }, spec: { containers: [{ name: n.split("-").slice(0, -2).join("-"), image: img }], nodeName: "minikube" } }, this.creeA); p.systeme = true; p.status = { phase: "Running", podIP: "10.244.0." + (5 + Math.floor(Math.random() * 6)) }; p.pret = this.creeA; });
    }
    ajouterNs(n, t = H.now()) {
      this.ajouter({ apiVersion: "v1", kind: "Namespace", metadata: { name: n, labels: { "kubernetes.io/metadata.name": n } }, spec: { finalizers: ["kubernetes"] }, status: { phase: "Active" } }, t);
      this.ajouter({ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "kube-root-ca.crt", namespace: n, annotations: { "kubernetes.io/description": "Contains a CA bundle that can be used to verify the kube-apiserver when using internal endpoints such as the internal service IP or kubernetes.default.svc. No other usage is guaranteed across distributions of Kubernetes clusters." } }, data: { "ca.crt": "-----BEGIN CERTIFICATE-----\nMIIDBjCCAe6gAwIBAgIBATANBgkqhkiG9w0BAQsFADAVMRMwEQYDVQQDEwptaW5p\n-----END CERTIFICATE-----\n" } }, t);
    }
    ajouter(o, t = H.now()) {
      o.metadata = o.metadata || {};
      o.metadata.uid = o.metadata.uid || uuid();
      o.metadata.creationTimestamp = iso(t);
      o.metadata.resourceVersion = String(++this.version);
      o.cree = t;
      this.objets.push(o);
      return o;
    }
    trouver(kind, ns, nom) { return this.objets.find((o) => o.kind === kind && o.metadata.name === nom && (typeKind(kind).global || o.metadata.namespace === ns)) || null; }
    liste(kind, ns, sel) { return this.objets.filter((o) => o.kind === kind && (typeKind(kind).global || ns === null || o.metadata.namespace === ns) && (!sel || correspond(o.metadata.labels || {}, sel))); }
    nsExiste(ns) { const n = this.trouver("Namespace", null, ns); return n && !n.suppression; }
    retirer(o) { this.objets = this.objets.filter((x) => x !== o); if (o.conteneur) { const c = o.conteneur; if (c.etat === "running") { c.arretDemande = true; c.proc = c.proc || {}; c.proc.tFin = H.now(); this.noeud.fin(c, 0); } this.noeud.conteneurs = this.noeud.conteneurs.filter((x) => x !== c); } }

    /* ------------------------------------------------- contrôleurs */
    // Fait avancer le cluster jusqu'à t, événement par événement (pods prêts, pods arrêtés, namespaces supprimés).
    avancer(t) {
      if (this.etat !== "Running") return;
      for (let k = 0; k < 400; k++) {
        this.controleurs();
        const evs = [];
        this.objets.forEach((o) => {
          if (o.kind === "Pod" && !o.systeme) {
            if (!o.suppression && o.pret && !o.demarre && o.pret <= t) evs.push([o.pret, () => this.demarrerPod(o)]);
            if (o.suppression && o.finA <= t) evs.push([o.finA, () => this.retirer(o)]);
            if (o.finProgramme && !o.fini && o.finProgramme <= t) evs.push([o.finProgramme, () => { o.fini = true; o.status.phase = o.codeSortie ? "Failed" : "Succeeded"; }]);
          }
          if (o.kind === "Namespace" && o.suppression && o.finA <= t) evs.push([o.finA, () => this.purgerNs(o)]);
        });
        if (!evs.length) { this.controleurs(); return; }
        evs.sort((a, b) => a[0] - b[0]);
        H.fige = evs[0][1] && evs[0][0];
        try { evs[0][1](); } finally { H.fige = null; }
      }
    }
    prochainEvenement() {
      let t = Infinity;
      this.objets.forEach((o) => {
        if (o.kind === "Pod" && !o.systeme) { if (!o.suppression && o.pret && !o.demarre) t = Math.min(t, o.pret); if (o.suppression) t = Math.min(t, o.finA); if (o.finProgramme && !o.fini) t = Math.min(t, o.finProgramme); }
        if (o.kind === "Namespace" && o.suppression) t = Math.min(t, o.finA);
      });
      return t;
    }
    controleurs() {
      for (const d of this.liste("Deployment", null)) this.ctrlDeployment(d);
      for (const rs of this.liste("ReplicaSet", null)) this.ctrlReplicaSet(rs);
      for (const d of this.liste("Deployment", null)) this.statutDeployment(d);
      for (const s of this.liste("Service", null)) this.ctrlService(s);
      for (const pvc of this.liste("PersistentVolumeClaim", null)) this.ctrlPvc(pvc);
    }
    hashGabarit(tpl) { return D.hexDe(JSON.stringify(tpl), 10).replace(/^0+/, ""); }
    rsDe(d) { return this.liste("ReplicaSet", d.metadata.namespace).filter((rs) => (rs.metadata.ownerReferences || []).some((r) => r.uid === d.metadata.uid)); }
    podsDe(rs) { return this.liste("Pod", rs.metadata.namespace).filter((p) => (p.metadata.ownerReferences || []).some((r) => r.uid === rs.metadata.uid)); }
    ctrlDeployment(d) {
      if (d.suppression) return;
      d.status = d.status || {};
      d.status.observedGeneration = d.metadata.generation;
      const voulu = d.spec.replicas ?? 1;
      const hash = this.hashGabarit(d.spec.template);
      const tous = this.rsDe(d);
      let neuf = tous.find((rs) => rs.metadata.labels["pod-template-hash"] === hash);
      const maxRev = Math.max(0, ...tous.map((rs) => +(rs.metadata.annotations || {})["deployment.kubernetes.io/revision"] || 0));
      if (!neuf) {
        const tpl = clone(d.spec.template);
        tpl.metadata = tpl.metadata || {}; tpl.metadata.labels = Object.assign({}, tpl.metadata.labels, { "pod-template-hash": hash });
        neuf = this.ajouter({ apiVersion: "apps/v1", kind: "ReplicaSet", metadata: { name: `${d.metadata.name}-${hash}`, namespace: d.metadata.namespace, labels: Object.assign({}, d.spec.template.metadata.labels, { "pod-template-hash": hash }),
          annotations: { "deployment.kubernetes.io/desired-replicas": String(voulu), "deployment.kubernetes.io/max-replicas": String(voulu + 1), "deployment.kubernetes.io/revision": String(maxRev + 1) },
          ownerReferences: [{ apiVersion: "apps/v1", kind: "Deployment", name: d.metadata.name, uid: d.metadata.uid, controller: true, blockOwnerDeletion: true }] },
          spec: { replicas: tous.length ? 0 : 0, selector: { matchLabels: Object.assign({}, d.spec.selector.matchLabels, { "pod-template-hash": hash }) }, template: tpl }, status: { replicas: 0 } });
      } else if (+(neuf.metadata.annotations["deployment.kubernetes.io/revision"]) < maxRev && !d.revisionVue) {
        neuf.metadata.annotations["deployment.kubernetes.io/revision"] = String(maxRev + 1);
      }
      d.revisionVue = false;
      d.metadata.annotations = Object.assign({}, d.metadata.annotations, { "deployment.kubernetes.io/revision": neuf.metadata.annotations["deployment.kubernetes.io/revision"] });
      const anciens = this.rsDe(d).filter((rs) => rs !== neuf);
      const strat = (d.spec.strategy || {}).type || "RollingUpdate";
      if (strat === "Recreate") {
        anciens.forEach((rs) => { rs.spec.replicas = 0; });
        const restants = anciens.reduce((s, rs) => s + this.podsDe(rs).length, 0);
        if (!restants) neuf.spec.replicas = voulu;
        return;
      }
      const ru = (d.spec.strategy || {}).rollingUpdate || {};
      const val = (v, defaut, haut) => { if (v === undefined || v === null) v = defaut; if (typeof v === "string" && v.endsWith("%")) { const x = voulu * parseInt(v, 10) / 100; return haut ? Math.ceil(x) : Math.floor(x); } return parseInt(v, 10); };
      const surge = val(ru.maxSurge, "25%", true); let indispo = val(ru.maxUnavailable, "25%", false);
      if (!surge && !indispo) indispo = 1;
      if (!anciens.some((rs) => rs.spec.replicas > 0)) { neuf.spec.replicas = voulu; return; }
      // Montée du nouveau ReplicaSet dans la limite de maxSurge.
      const total = this.rsDe(d).reduce((s, rs) => s + rs.spec.replicas, 0);
      if (neuf.spec.replicas < voulu) { const plus = Math.min(voulu + surge - total, voulu - neuf.spec.replicas); if (plus > 0) neuf.spec.replicas += plus; }
      // Descente des anciens dans la limite de maxUnavailable.
      const tousPods = this.rsDe(d).reduce((s, rs) => s + rs.spec.replicas, 0);
      const prets = (rs) => this.podsDe(rs).filter((p) => p.demarre && !p.suppression).length;
      const indispoNeuf = neuf.spec.replicas - prets(neuf);
      let reduction = tousPods - (voulu - indispo) - indispoNeuf;
      for (const rs of anciens) { if (reduction <= 0) break; const r = Math.min(rs.spec.replicas, reduction); rs.spec.replicas -= r; reduction -= r; }
    }
    ctrlReplicaSet(rs) {
      const pods = this.podsDe(rs).filter((p) => !p.suppression);
      const voulu = rs.spec.replicas;
      for (let k = pods.length; k < voulu; k++) this.creerPod(rs);
      if (pods.length > voulu) pods.sort((a, b) => (a.demarre ? 1 : 0) - (b.demarre ? 1 : 0) || b.cree - a.cree).slice(0, pods.length - voulu).forEach((p) => this.supprimerPod(p));
      const vivants = this.podsDe(rs).filter((p) => !p.suppression);
      rs.status = { replicas: vivants.length, readyReplicas: vivants.filter((p) => p.demarre).length, availableReplicas: vivants.filter((p) => p.demarre).length, fullyLabeledReplicas: vivants.length, observedGeneration: 1 };
    }
    statutDeployment(d) {
      const tous = this.rsDe(d); const hash = this.hashGabarit(d.spec.template);
      const neuf = tous.find((rs) => rs.metadata.labels["pod-template-hash"] === hash);
      const pods = tous.flatMap((rs) => this.podsDe(rs)).filter((p) => !p.suppression);
      const maj = neuf ? this.podsDe(neuf).filter((p) => !p.suppression) : [];
      d.status = Object.assign(d.status || {}, { replicas: pods.length, updatedReplicas: maj.length, readyReplicas: pods.filter((p) => p.demarre).length, availableReplicas: pods.filter((p) => p.demarre).length, unavailableReplicas: Math.max(0, (d.spec.replicas ?? 1) - pods.filter((p) => p.demarre).length) });
      d.status.terminants = tous.flatMap((rs) => this.podsDe(rs)).filter((p) => p.suppression).length;
    }
    creerPod(rs, o = {}) {
      const tpl = rs ? rs.spec.template : o.template;
      const nom = rs ? `${rs.metadata.name}-${suffixe()}` : o.nom;
      const p = this.ajouter({ apiVersion: "v1", kind: "Pod", metadata: { name: nom, namespace: rs ? rs.metadata.namespace : o.ns, labels: clone((tpl.metadata || {}).labels || {}),
        ownerReferences: rs ? [{ apiVersion: "apps/v1", kind: "ReplicaSet", name: rs.metadata.name, uid: rs.metadata.uid, controller: true, blockOwnerDeletion: true }] : undefined },
        spec: Object.assign({ restartPolicy: "Always", nodeName: "minikube", terminationGracePeriodSeconds: 30 }, clone(tpl.spec)), status: { phase: "Pending", podIP: "" } });
      if (!rs) delete p.metadata.ownerReferences;
      const img = p.spec.containers[0].image;
      const tire = this.imagesTirees.has(img);
      p.pret = H.now() + (tire ? O.entre(900, 1800) : { postgres: 7500, busybox: 2500 }[img.split(":")[0]] || O.entre(4200, 5600));
      return p;
    }
    demarrerPod(p) {
      const c0 = p.spec.containers[0];
      this.imagesTirees.add(c0.image);
      const ns = p.metadata.namespace;
      // Variables d'environnement : env, envFrom (Secret, ConfigMap).
      const env = [];
      (c0.envFrom || []).forEach((ef) => {
        const src = ef.secretRef ? this.trouver("Secret", ns, ef.secretRef.name) : ef.configMapRef ? this.trouver("ConfigMap", ns, ef.configMapRef.name) : null;
        if (!src) return;
        Object.entries(src.data || {}).forEach(([k, v]) => env.push(`${k}=${ef.secretRef ? atob(v) : v}`));
      });
      (c0.env || []).forEach((e) => env.push(`${e.name}=${e.value !== undefined ? e.value : ""}`));
      const r = D.Moteur.ref(c0.image);
      let im = this.noeud.image(c0.image);
      if (!im) { im = this.noeud.imageDeBase(r); if (im) this.noeud.images.set(r.ref, im); }
      if (!im) { p.status.phase = "Pending"; p.erreurImage = true; p.demarre = null; p.pret = Infinity; return; }
      const cmd = (c0.command || []).concat(c0.args || []);
      const c = this.noeud.creer(im, { nom: `k8s_${c0.name}_${p.metadata.name}_${ns}_${p.metadata.uid}_0`, imageTapee: c0.image, env, reseau: "k8s", cmd: cmd.length ? cmd : undefined, labels: { "io.kubernetes.pod.name": p.metadata.name, "io.kubernetes.pod.namespace": ns } });
      c.pod = p; c.config.Hostname = p.metadata.name;
      this.noeud.demarrer(c);
      c.reseaux.k8s.ip = `10.244.0.${this.ipPod++}`;
      p.conteneur = c; p.demarre = H.now(); p.status.phase = "Running"; p.status.podIP = c.reseaux.k8s.ip; p.status.hostIP = IP_NOEUD; p.status.startTime = iso(p.cree);
      if (c.etat !== "running") { p.finProgramme = H.now(); p.codeSortie = c.code; }
    }
    supprimerPod(p, grace) {
      if (p.suppression) return;
      p.suppression = H.now();
      const img = (p.spec.containers[0] || {}).image || "";
      p.finA = H.now() + (grace !== undefined ? grace : /postgres/.test(img) ? O.entre(600, 1100) : O.entre(700, 1600));
      if (!p.demarre) p.finA = H.now() + 300;
    }
    ctrlService(s) {
      if (!s.spec.selector) return;
      let eps = this.liste("EndpointSlice", s.metadata.namespace).find((e) => e.metadata.labels["kubernetes.io/service-name"] === s.metadata.name);
      if (!eps) eps = this.ajouter({ apiVersion: "discovery.k8s.io/v1", kind: "EndpointSlice", addressType: "IPv4", metadata: { name: `${s.metadata.name}-${suffixe()}`, namespace: s.metadata.namespace, labels: { "kubernetes.io/service-name": s.metadata.name, "endpointslice.kubernetes.io/managed-by": "endpointslice-controller.k8s.io" } }, ports: (s.spec.ports || []).map((p) => ({ name: p.name || "", port: p.targetPort || p.port, protocol: p.protocol || "TCP" })), endpoints: [] }, s.cree);
      const pods = this.liste("Pod", s.metadata.namespace, s.spec.selector).filter((p) => p.demarre && !p.suppression && !p.fini);
      eps.endpoints = pods.map((p) => ({ addresses: [p.status.podIP], conditions: { ready: true }, targetRef: { kind: "Pod", name: p.metadata.name, namespace: p.metadata.namespace }, ip: p.status.podIP }))
        .sort((a, b) => parseInt(a.ip.split(".")[3], 10) - parseInt(b.ip.split(".")[3], 10));
    }
    ctrlPvc(pvc) {
      if (pvc.status && pvc.status.phase === "Bound") return;
      const taille = (((pvc.spec.resources || {}).requests || {}).storage) || "1Gi";
      const nom = "pvc-" + uuid();
      this.ajouter({ apiVersion: "v1", kind: "PersistentVolume", metadata: { name: nom, annotations: { "hostPathProvisionerIdentity": uuid(), "pv.kubernetes.io/provisioned-by": "k8s.io/minikube-hostpath" } },
        spec: { accessModes: pvc.spec.accessModes || ["ReadWriteOnce"], capacity: { storage: taille }, claimRef: { kind: "PersistentVolumeClaim", name: pvc.metadata.name, namespace: pvc.metadata.namespace, uid: pvc.metadata.uid }, hostPath: { path: `/tmp/hostpath-provisioner/${pvc.metadata.namespace}/${pvc.metadata.name}` }, persistentVolumeReclaimPolicy: "Delete", storageClassName: "standard", volumeMode: "Filesystem" }, status: { phase: "Bound" } });
      pvc.spec.volumeName = nom; pvc.spec.storageClassName = pvc.spec.storageClassName || "standard";
      pvc.status = { phase: "Bound", accessModes: pvc.spec.accessModes || ["ReadWriteOnce"], capacity: { storage: taille } };
    }
    supprimerNs(ns) {
      ns.suppression = H.now(); ns.status.phase = "Terminating";
      const pods = this.liste("Pod", ns.metadata.name);
      pods.forEach((p) => this.supprimerPod(p));
      ns.finA = Math.max(H.now() + 1200, ...pods.map((p) => p.finA + 900));
    }
    purgerNs(ns) {
      const n = ns.metadata.name;
      this.objets.filter((o) => o.metadata.namespace === n).forEach((o) => this.retirer(o));
      this.liste("PersistentVolume", null).filter((pv) => pv.spec.claimRef && pv.spec.claimRef.namespace === n).forEach((pv) => this.retirer(pv));
      this.retirer(ns);
    }
    // Arrête ou relance les conteneurs des pods avec le nœud.
    arreter() {
      this.objets.filter((o) => o.kind === "Pod" && o.conteneur).forEach((p) => { const c = p.conteneur; if (c.etat === "running") { c.arretDemande = true; c.proc = c.proc || {}; c.proc.tFin = H.now(); this.noeud.fin(c, 0); } this.noeud.conteneurs = this.noeud.conteneurs.filter((x) => x !== c); p.conteneur = null; p.demarre = null; p.pret = Infinity; });
      this.forwards.forEach((f) => f.arreter()); this.forwards = [];
      this.etat = "Stopped";
    }
    relancer() {
      this.etat = "Running"; this.demarreA = H.now();
      this.objets.filter((o) => o.kind === "Pod" && !o.systeme && !o.fini).forEach((p) => { p.pret = H.now() + O.entre(2000, 6000); p.redemarrages = (p.redemarrages || 0) + 1; });
      this.objets.filter((o) => o.kind === "Pod" && o.systeme).forEach((p) => { p.redemarrages = (p.redemarrages || 0) + 1; });
    }
  }

  function correspond(labels, sel) {
    if (!sel) return true;
    if (typeof sel === "object") return Object.entries(sel.matchLabels || sel).every(([k, v]) => labels[k] === v);
    return sel.split(",").every((c) => {
      const m = /^\s*([\w./-]+)\s*(!=|==|=)\s*([\w.-]*)\s*$/.exec(c);
      if (m) return m[2] === "!=" ? labels[m[1]] !== m[3] : labels[m[1]] === m[3];
      const ex = /^\s*(!?)([\w./-]+)\s*$/.exec(c);
      if (ex) return ex[1] ? !(ex[2] in labels) : ex[2] in labels;
      const inn = /^\s*([\w./-]+)\s+(in|notin)\s+\(([^)]*)\)\s*$/.exec(c);
      if (inn) { const vals = inn[3].split(/\s*,\s*/); return inn[2] === "in" ? vals.includes(labels[inn[1]]) : !vals.includes(labels[inn[1]]); }
      return false;
    });
  }

  let K = null;
  (SIM.surReinit = SIM.surReinit || []).push((hote) => { K = new Cluster(hote); hote.k8s = K; });
  SIM.surTic((t) => { if (K) { K.avancer(t); K.noeud.avancerTout(t); } });
  SIM.resolveurs = SIM.resolveurs || [];
  SIM.fondEnAttente = SIM.fondEnAttente || [];
  // curl vers un port-forward actif.
  SIM.resolveurs.push((hote, port, req) => {
    if (!K || !["127.0.0.1", "localhost"].includes(hote)) return null;
    const f = K.forwards.find((x) => String(x.local) === String(port));
    if (!f) return null;
    const p = f.pod();
    if (!p || !p.conteneur) return { refus: true };
    f.journal(`Handling connection for ${port}`);
    return K.noeud.servir(p.conteneur, { ...req, port: f.distant, de: "127.0.0.1" });
  });
  SIM.portsHoteOccupes = () => (K ? K.forwards.map((f) => "127.0.0.1:" + f.local) : []);
  SIM.ecoutesHote = () => (K ? K.forwards.flatMap((f) => [`127.0.0.1:${f.local}`, `[::1]:${f.local}`]) : []);
  // DNS du cluster vu d'un pod : <service>, <service>.<ns>, <service>.<ns>.svc.cluster.local.
  SIM.resoudreExterne = (nom, depuis) => {
    if (!K || !depuis || !depuis.pod) return null;
    const m = /^([a-z0-9-]+)(?:\.([a-z0-9-]+))?(?:\.svc(?:\.cluster\.local)?)?$/.exec(nom);
    if (!m) return null;
    const s = K.trouver("Service", m[2] || depuis.pod.metadata.namespace, m[1]);
    if (!s) return null;
    const eps = K.liste("Pod", s.metadata.namespace, s.spec.selector).filter((p) => p.demarre && !p.suppression && p.conteneur);
    const cible = eps[Math.floor(Math.random() * eps.length)];
    const port0 = (s.spec.ports || [])[0] || {};
    return { ip: s.spec.clusterIP, cible: cible ? cible.conteneur : null, servir: cible ? (req) => K.noeud.servir(cible.conteneur, { ...req, port: String(port0.targetPort || port0.port || 80) }) : null };
  };

  /* ------------------------------------------------------------- sorties */
  const T = (lignes) => O.tableau(lignes, 3, 0);
  function lignesTable(type, objs, o) {
    const now = H.now();
    const lab = (x) => Object.entries(x.metadata.labels || {}).sort().map(([k, v]) => `${k}=${v}`).join(",") || "<none>";
    const nomAff = (x) => (o.prefixe ? `${type.prefixe}/` : "") + x.metadata.name;
    let tete; let rang;
    switch (type.kind) {
      case "Pod": {
        tete = ["NAME", "READY", "STATUS", "RESTARTS", "AGE"];
        rang = (p) => {
          const statut = p.suppression ? "Terminating" : p.fini ? (p.codeSortie ? "Error" : "Completed") : p.erreurImage ? "ErrImagePull" : p.demarre || p.systeme ? "Running" : "ContainerCreating";
          const pret = (p.demarre || p.systeme) && !p.fini && !p.suppression ? "1/1" : "0/1";
          return [nomAff(p), pret, statut, String(p.redemarrages ? p.redemarrages + ` (${age(now - (K.demarreA || now))} ago)` : 0), age(now - p.cree)];
        };
        if (o.wide) { tete = tete.concat(["IP", "NODE", "NOMINATED NODE", "READINESS GATES"]); const r0 = rang; rang = (p) => r0(p).concat([p.status.podIP || "<none>", "minikube", "<none>", "<none>"]); }
        break;
      }
      case "Deployment":
        tete = ["NAME", "READY", "UP-TO-DATE", "AVAILABLE", "AGE"];
        rang = (d) => [nomAff(d), `${d.status.readyReplicas || 0}/${d.spec.replicas ?? 1}`, String(d.status.updatedReplicas || 0), String(d.status.availableReplicas || 0), age(now - d.cree)];
        if (o.wide) { tete = tete.concat(["CONTAINERS", "IMAGES", "SELECTOR"]); const r0 = rang; rang = (d) => r0(d).concat([d.spec.template.spec.containers.map((c) => c.name).join(","), d.spec.template.spec.containers.map((c) => c.image).join(","), Object.entries(d.spec.selector.matchLabels).map(([k, v]) => `${k}=${v}`).join(",")]); }
        break;
      case "ReplicaSet":
        tete = ["NAME", "DESIRED", "CURRENT", "READY", "AGE"];
        rang = (r) => [nomAff(r), String(r.spec.replicas), String(r.status.replicas || 0), String(r.status.readyReplicas || 0), age(now - r.cree)];
        if (o.wide) { tete = tete.concat(["CONTAINERS", "IMAGES", "SELECTOR"]); const r0 = rang; rang = (r) => r0(r).concat([r.spec.template.spec.containers.map((c) => c.name).join(","), r.spec.template.spec.containers.map((c) => c.image).join(","), Object.entries(r.spec.selector.matchLabels).map(([k, v]) => `${k}=${v}`).join(",")]); }
        break;
      case "Service":
        tete = ["NAME", "TYPE", "CLUSTER-IP", "EXTERNAL-IP", "PORT(S)", "AGE"];
        rang = (s) => [nomAff(s), s.spec.type || "ClusterIP", s.spec.clusterIP, s.spec.type === "LoadBalancer" ? "<pending>" : "<none>", (s.spec.ports || []).map((p) => `${p.port}${p.nodePort ? ":" + p.nodePort : ""}/${p.protocol || "TCP"}`).join(","), age(now - s.cree)];
        if (o.wide) { tete = tete.concat(["SELECTOR"]); const r0 = rang; rang = (s) => r0(s).concat([s.spec.selector ? Object.entries(s.spec.selector).map(([k, v]) => `${k}=${v}`).join(",") : "<none>"]); }
        break;
      case "EndpointSlice":
        tete = ["NAME", "ADDRESSTYPE", "PORTS", "ENDPOINTS", "AGE"];
        rang = (e) => [nomAff(e), e.addressType, (e.ports || []).map((p) => p.port).join(",") || "<unset>", e.endpoints.length ? e.endpoints.map((x) => x.ip).slice(0, 3).join(",") + (e.endpoints.length > 3 ? ` + ${e.endpoints.length - 3} more...` : "") : "<unset>", age(now - e.cree)];
        break;
      case "ConfigMap": tete = ["NAME", "DATA", "AGE"]; rang = (c) => [nomAff(c), String(Object.keys(c.data || {}).length), age(now - c.cree)]; break;
      case "Secret": tete = ["NAME", "TYPE", "DATA", "AGE"]; rang = (s) => [nomAff(s), s.type || "Opaque", String(Object.keys(s.data || {}).length), age(now - s.cree)]; break;
      case "PersistentVolumeClaim": tete = ["NAME", "STATUS", "VOLUME", "CAPACITY", "ACCESS MODES", "STORAGECLASS", "VOLUMEATTRIBUTESCLASS", "AGE"]; rang = (p) => [nomAff(p), (p.status || {}).phase || "Pending", p.spec.volumeName || "", ((p.status || {}).capacity || {}).storage || "", (p.spec.accessModes || []).map((a) => ({ ReadWriteOnce: "RWO", ReadOnlyMany: "ROX", ReadWriteMany: "RWX" }[a])).join(","), p.spec.storageClassName || "standard", "<unset>", age(now - p.cree)]; break;
      case "PersistentVolume": tete = ["NAME", "CAPACITY", "ACCESS MODES", "RECLAIM POLICY", "STATUS", "CLAIM", "STORAGECLASS", "VOLUMEATTRIBUTESCLASS", "REASON", "AGE"]; rang = (p) => [nomAff(p), p.spec.capacity.storage, p.spec.accessModes.map((a) => ({ ReadWriteOnce: "RWO" }[a] || a)).join(","), p.spec.persistentVolumeReclaimPolicy, p.status.phase, `${p.spec.claimRef.namespace}/${p.spec.claimRef.name}`, p.spec.storageClassName, "<unset>", "", age(now - p.cree)]; break;
      case "Namespace": tete = ["NAME", "STATUS", "AGE"]; rang = (n) => [nomAff(n), n.status.phase, age(now - n.cree)]; break;
      case "Node":
        tete = ["NAME", "STATUS", "ROLES", "AGE", "VERSION"]; rang = (n) => [nomAff(n), "Ready", "control-plane", age(now - K.creeA), "v1.37.0"];
        if (o.wide) { tete = tete.concat(["INTERNAL-IP", "EXTERNAL-IP", "OS-IMAGE", "KERNEL-VERSION", "CONTAINER-RUNTIME"]); const r0 = rang; rang = (n) => r0(n).concat([IP_NOEUD, "<none>", "Debian GNU/Linux 12 (bookworm)", SIM.noyauVersion, "containerd://2.3.4"]); }
        break;
      case "Ingress": tete = ["NAME", "CLASS", "HOSTS", "ADDRESS", "PORTS", "AGE"]; rang = (i) => [nomAff(i), (i.spec || {}).ingressClassName || "<none>", "*", "", "80", age(now - i.cree)]; break;
      default: tete = ["NAME", "AGE"]; rang = (x) => [nomAff(x), age(now - x.cree)];
    }
    if (o.labels) { tete = tete.concat(["LABELS"]); const r0 = rang; rang = (x) => r0(x).concat([lab(x)]); }
    if (o.tous) { tete = ["NAMESPACE"].concat(tete); const r0 = rang; rang = (x) => [x.metadata.namespace].concat(r0(x)); }
    return [tete].concat(objs.map(rang));
  }
  // Objet tel que renvoyé par l'API (sans les champs internes du simulateur).
  function vueApi(o) {
    if (o.kind === "Node") return o;
    const v = {};
    ["apiVersion", "kind", "metadata", "spec", "status", "data", "type", "addressType", "endpoints", "ports"].forEach((k) => { if (o[k] !== undefined) v[k] = clone(o[k]); });
    if (v.endpoints) v.endpoints = v.endpoints.map((e) => ({ addresses: e.addresses, conditions: e.conditions, targetRef: e.targetRef }));
    if (v.status) delete v.status.terminants;
    if (o.kind === "Pod") v.status = Object.assign({ phase: o.suppression ? "Running" : o.fini ? (o.codeSortie ? "Failed" : "Succeeded") : o.demarre || o.systeme ? "Running" : "Pending", podIP: o.status.podIP, hostIP: IP_NOEUD }, {});
    return v;
  }
  function noeud() {
    return { apiVersion: "v1", kind: "Node", cree: K.creeA, metadata: { name: "minikube", labels: { "kubernetes.io/hostname": "minikube", "kubernetes.io/os": "linux", "kubernetes.io/arch": "amd64", "minikube.k8s.io/name": "minikube", "minikube.k8s.io/primary": "true", "minikube.k8s.io/version": "v1.39.0", "node-role.kubernetes.io/control-plane": "" }, creationTimestamp: iso(K.creeA), uid: D.hexDe("noeud").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*/, "$1-$2-$3-$4-$5") },
      status: { addresses: [{ type: "InternalIP", address: IP_NOEUD }, { type: "Hostname", address: "minikube" }], capacity: { cpu: "12", memory: "7971468Ki", pods: "110" }, conditions: [{ type: "Ready", status: "True", reason: "KubeletReady" }],
        nodeInfo: { architecture: "amd64", containerRuntimeVersion: "containerd://2.3.4", kernelVersion: SIM.noyauVersion, kubeProxyVersion: "", kubeletVersion: "v1.37.0", operatingSystem: "linux", osImage: "Debian GNU/Linux 12 (bookworm)" } } };
  }
  // JSONPath de kubectl : {.a.b[0].c}, {"\n"}, {range .items[*]}…{end}, [*].
  function jsonpath(expr, donnee) {
    const toks = []; let i = 0;
    while (i < expr.length) {
      if (expr[i] === "{") { const j = expr.indexOf("}", i); toks.push({ e: expr.slice(i + 1, j).trim() }); i = j + 1; }
      else { const j = expr.indexOf("{", i); const f = j < 0 ? expr.length : j; toks.push({ t: expr.slice(i, f) }); i = f; }
    }
    const chemin2 = (p, d) => {
      let vals = [d];
      const seg = p.replace(/^\$?\.?/, "").match(/[^.[\]]+|\[[^\]]*\]/g) || [];
      for (const s of seg) {
        vals = vals.flatMap((v) => {
          if (v == null) return [];
          if (s === "[*]" || s === "*") return Array.isArray(v) ? v : Object.values(v);
          const m = /^\[(-?\d+)\]$/.exec(s); if (m) return Array.isArray(v) ? [v[+m[1] < 0 ? v.length + +m[1] : +m[1]]] : [];
          const q = /^\['?"?([^'"\]]+)'?"?\]$/.exec(s); const k = q ? q[1] : s;
          return v[k] === undefined ? [] : [v[k]];
        });
      }
      return vals;
    };
    const fmt = (v) => (typeof v === "object" && v !== null ? JSON.stringify(v) : String(v));
    let p = 0;
    const rendre = (d) => {
      let out = "";
      while (p < toks.length) {
        const t = toks[p];
        if (t.t !== undefined) { out += t.t; p++; continue; }
        if (t.e === "end") { p++; return out; }
        if (/^range\s/.test(t.e)) {
          const items = chemin2(t.e.slice(6).trim(), d); p++;
          const debut = p; let fin = p;
          if (!items.length) { let prof = 1; while (p < toks.length && prof) { if (toks[p].e && /^range\s/.test(toks[p].e)) prof++; if (toks[p].e === "end") prof--; p++; } continue; }
          items.forEach((it) => { p = debut; out += rendre(it); fin = p; });
          p = fin; continue;
        }
        if (/^"/.test(t.e) || /^'/.test(t.e)) { out += JSON.parse('"' + t.e.slice(1, -1).replace(/"/g, '\\"') + '"'); p++; continue; }
        out += chemin2(t.e, d).map(fmt).join(" "); p++;
      }
      return out;
    };
    return rendre(donnee);
  }

  /* --------------------------------------------------------- kubectl */
  // Cluster arrêté : sortie réelle de kubectl après « minikube stop » sur la machine de référence.
  const ERRCONN = () => {
    const d = new Date(H.now()); const z = (v) => String(v).padStart(2, "0");
    const pid = 345000 + Math.floor(Math.random() * 5000);
    const l = Array.from({ length: 5 }, (_, k) => ({ t: `E${z(d.getUTCMonth() + 1)}${z(d.getUTCDate())} ${z(d.getUTCHours())}:${z(d.getUTCMinutes())}:${z(d.getUTCSeconds())}.${427348 + k * 1100}  ${pid} memcache.go:381] "Couldn't get current server API group list" err="Get \\"http://localhost:8080/api?timeout=32s\\": dial tcp 127.0.0.1:8080: connect: connection refused"`, e: true }));
    l.push({ t: "The connection to the server localhost:8080 was refused - did you specify the right host or port?", e: true });
    return { l, code: 1 };
  };
  function opts(args) {
    const o = { ns: null, sel: null, sortie: null, ops: [], apres: null, fichiers: [], lit: [], fichiersCm: [] };
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--") { o.apres = args.slice(i + 1); break; }
      const kv = /^(--?[\w-]+)=(.*)$/s.exec(a); const cle = kv ? kv[1] : a; const val = () => (kv ? kv[2] : args[++i]);
      switch (cle) {
        case "-n": case "--namespace": o.ns = val(); break;
        case "-l": case "--selector": o.sel = val(); break;
        case "-o": case "--output": o.sortie = val(); break;
        case "-f": case "--filename": o.fichiers.push(val()); break;
        case "-A": case "--all-namespaces": o.tous = true; break;
        case "--show-labels": o.labels = true; break;
        case "--from-literal": o.lit.push(val()); break;
        case "--from-file": o.fichiersCm.push(val()); break;
        case "--image": o.image = val(); break;
        case "--replicas": o.replicas = parseInt(val(), 10); break;
        case "--port": o.port = val(); break;
        case "--target-port": o.targetPort = val(); break;
        case "--type": o.type = val(); break;
        case "--name": o.nom = val(); break;
        case "--restart": o.restart = val(); break;
        case "--dry-run": o.dryRun = kv ? kv[2] : "client"; break;
        case "--timeout": o.timeout = val(); break;
        case "--wait": o.wait = kv ? kv[2] !== "false" : true; break;
        case "--rm": o.rm = true; break;
        case "-it": case "-ti": case "-i": case "-t": case "--stdin": case "--tty": o.it = true; break;
        case "--to-revision": o.revision = val(); break;
        case "--grace-period": o.grace = parseInt(val(), 10); break;
        case "--force": case "--now": o.force = true; break;
        case "--context": case "--kubeconfig": case "--record": case "--save-config": val(); break;
        case "--client": o.client = true; break;
        case "-c": case "--container": val(); break;
        case "-w": case "--watch": o.watch = true; break;
        case "-p": o.p = true; break;
        default: if (cle.startsWith("-")) o.inconnu = o.inconnu || cle; else o.ops.push(a);
      }
    }
    return o;
  }
  const nsDe = (o) => o.ns || "default";

  const KC = {};
  KC.version = (x, o) => {
    const l = ["Client Version: v1.37.1", "Kustomize Version: v5.8.1"];
    if (o.client) return R.ok(l);
    if (K.etat !== "Running") return { l: l.map((t) => ({ t })).concat(ERRCONN().l.slice(-1)), code: 1 };
    return R.ok(l.concat(["Server Version: v1.37.0"]));
  };
  KC.config = (x, o) => {
    const sous = o.ops[0];
    if (sous === "get-contexts") return R.ok(T([["CURRENT", "NAME", "CLUSTER", "AUTHINFO", "NAMESPACE"], ["*", "minikube", "minikube", "minikube", "default"]]));
    if (sous === "current-context") return R.ok("minikube");
    if (sous === "use-context") return o.ops[1] === "minikube" ? R.ok(`Switched to context "minikube".`) : R.err(`error: no context exists with the name: "${o.ops[1]}"`, 1);
    if (sous === "view") return R.ok(["apiVersion: v1", "clusters:", "- cluster:", "    certificate-authority: /home/eleve/.minikube/ca.crt", `    server: https://${IP_NOEUD}:8443`, "  name: minikube", "contexts:", "- context:", "    cluster: minikube", "    namespace: default", "    user: minikube", "  name: minikube", "current-context: minikube", "kind: Config", "users:", "- name: minikube", "  user:", "    client-certificate: /home/eleve/.minikube/profiles/minikube/client.crt", "    client-key: /home/eleve/.minikube/profiles/minikube/client.key"]);
    if (sous === "set-context") return R.ok(`Context "minikube" modified.`);
    return R.err(`error: unknown command "${sous || ""}" for "kubectl config"`, 1);
  };
  KC["cluster-info"] = () => R.ok([`Kubernetes control plane is running at https://${IP_NOEUD}:8443`, `CoreDNS is running at https://${IP_NOEUD}:8443/api/v1/namespaces/kube-system/services/kube-dns:dns/proxy`, "", "To further debug and diagnose cluster problems, use 'kubectl cluster-info dump'."]);

  KC.get = (x, o) => {
    if (!o.ops.length) return R.err(["You must specify the type of resource to get. Use \"kubectl api-resources\" for a complete list of supported resources.", "", "error: Required resource not specified.", "Use \"kubectl explain <resource>\" for a detailed description of that resource (e.g. kubectl explain pods).", "See 'kubectl get -h' for help and examples"], 1);
    let specs = [];
    if (o.ops[0].includes("/")) specs = o.ops.map((s) => { const [t, n] = s.split("/"); return { t, noms: [n] }; });
    else specs = o.ops[0].split(",").map((t) => ({ t, noms: o.ops.slice(1) }));
    if (specs.length === 1 && specs[0].t === "all") specs = ["pods", "services", "deployments", "replicasets"].map((t) => ({ t, noms: [] }));
    const multi = specs.length > 1 || o.ops[0] === "all";
    const l = []; let code = 0; const json = [];
    const ns = o.tous ? null : nsDe(o);
    if (ns && !K.nsExiste(ns) && !specs.every((s) => (typeDe(s.t) || {}).global)) { l.push({ t: `No resources found in ${ns} namespace.`, e: true }); return { l, code: 0 }; }
    for (const s of specs) {
      const type = typeDe(s.t);
      if (!type) { l.push({ t: `error: the server doesn't have a resource type "${s.t}"`, e: true }); code = 1; continue; }
      let objs = type.kind === "Node" ? [noeud()] : K.liste(type.kind, type.global ? null : ns, o.sel);
      if (type.kind === "Node" && o.sel) objs = objs.filter((n) => correspond(n.metadata.labels, o.sel));
      if (s.noms.length) {
        const trouves = [];
        for (const n of s.noms) { const ob = objs.find((x) => x.metadata.name === n); if (!ob) { l.push({ t: `Error from server (NotFound): ${type.groupe} "${n}" not found`, e: true }); code = 1; } else trouves.push(ob); }
        objs = trouves;
      }
      objs.sort((a, b) => (a.metadata.namespace || "").localeCompare(b.metadata.namespace || "") || a.metadata.name.localeCompare(b.metadata.name));
      if (o.sortie && /^(json|yaml|jsonpath|custom-columns|name)/.test(o.sortie)) {
        if (o.sortie === "name") { objs.forEach((x) => l.push({ t: `${type.prefixe}/${x.metadata.name}` })); continue; }
        objs.forEach((x) => json.push(vueApi(x)));
        continue;
      }
      if (!objs.length) { if (!s.noms.length && !multi) l.push({ t: o.tous ? "No resources found" : type.global ? "No resources found" : `No resources found in ${ns} namespace.`, e: true }); continue; }
      if (l.some((y) => !y.e)) l.push({ t: "" });
      T(lignesTable(type, objs, { prefixe: multi, wide: o.sortie === "wide", labels: o.labels, tous: o.tous && !type.global })).forEach((t) => l.push({ t }));
    }
    if (o.sortie && /^(json|yaml|jsonpath|custom-columns)/.test(o.sortie)) {
      const unique = json.length === 1 && specs.length === 1 && specs[0].noms.length === 1;
      const donnee = unique ? json[0] : { apiVersion: "v1", items: json, kind: "List", metadata: { resourceVersion: "" } };
      if (o.sortie === "json") return { l: JSON.stringify(donnee, null, 4).split("\n").map((t) => ({ t })).concat(l), code };
      if (o.sortie === "yaml") return { l: yaml().dump(donnee, { sortKeys: true, noArrayIndent: true, lineWidth: -1, quotingType: '"' }).replace(/\n$/, "").split("\n").map((t) => ({ t })).concat(l), code };
      if (o.sortie.startsWith("jsonpath")) {
        const ex = o.sortie.replace(/^jsonpath=/, "");
        const txt = jsonpath(ex, donnee);
        const lignes = txt.split("\n"); const fin = txt.endsWith("\n"); if (fin) lignes.pop();
        const out = lignes.map((t) => ({ t }));
        if (!fin && out.length) out[out.length - 1].brut = out[out.length - 1].t;
        return { l: out.concat(l), code };
      }
      if (o.sortie.startsWith("custom-columns=")) {
        const cols = o.sortie.slice(15).split(",").map((c) => { const k = c.indexOf(":"); return [c.slice(0, k), c.slice(k + 1)]; });
        const items = unique ? [json[0]] : json;
        const rangs = items.map((it) => cols.map(([, p]) => { const v = jsonpath(`{${p}}`, it); return v === "" ? "<none>" : v; }));
        return { l: T([cols.map(([n]) => n)].concat(rangs)).map((t) => ({ t })).concat(l), code };
      }
    }
    return { l, code };
  };

  KC.describe = (x, o) => {
    const [t, n0] = o.ops[0] && o.ops[0].includes("/") ? o.ops[0].split("/") : [o.ops[0], o.ops[1]];
    const type = typeDe(t || "");
    if (!type) return R.err(`error: the server doesn't have a resource type "${t}"`, 1);
    const ns = nsDe(o);
    let objs = type.kind === "Node" ? [noeud()] : K.liste(type.kind, type.global ? null : ns, o.sel);
    if (n0) objs = objs.filter((ob) => ob.metadata.name === n0 || ob.metadata.name.startsWith(n0));
    if (!objs.length) return n0 ? R.err(`Error from server (NotFound): ${type.groupe} "${n0}" not found`, 1) : R.err(`No resources found in ${ns} namespace.`, 0);
    const l = [];
    const labels = (lb) => { const e = Object.entries(lb || {}).sort(); return e.length ? e.map(([k, v], i) => (i ? "                " : "") + `${k}=${v}`) : ["<none>"]; };
    objs.forEach((ob, idx) => {
      if (idx) l.push("", "");
      const tete = (k, v) => l.push(O.pad(k + ":", 16) + v);
      if (type.kind === "Pod") {
        const p = ob; const c0 = p.spec.containers[0];
        tete("Name", p.metadata.name); tete("Namespace", p.metadata.namespace); tete("Priority", "0"); tete("Service Account", "default"); tete("Node", `minikube/${IP_NOEUD}`);
        tete("Start Time", new Date(p.cree).toUTCString().replace("GMT", "+0000"));
        const lb = labels(p.metadata.labels); tete("Labels", lb[0]); lb.slice(1).forEach((v) => l.push(v));
        tete("Annotations", "<none>"); tete("Status", p.suppression ? "Terminating" : p.demarre ? "Running" : "Pending"); tete("IP", p.status.podIP || "");
        l.push("IPs:"); if (p.status.podIP) l.push(`  IP:           ${p.status.podIP}`);
        const own = (p.metadata.ownerReferences || [])[0];
        tete("Controlled By", own ? `${own.kind}/${own.name}` : "<none>");
        l.push("Containers:", `  ${c0.name}:`, `    Container ID:   ${p.conteneur ? "containerd://" + p.conteneur.idLong : ""}`, `    Image:          ${c0.image}`, `    Image ID:       docker.io/library/${c0.image.split(":")[0]}@sha256:${D.hexDe(c0.image)}`,
          `    Port:           ${(c0.ports || [])[0] ? (c0.ports[0].containerPort + "/TCP") : "<none>"}`, `    Host Port:      ${(c0.ports || [])[0] ? "0/TCP" : "<none>"}`, `    State:          ${p.demarre ? "Running" : "Waiting"}`);
        if (p.demarre) l.push(`      Started:      ${new Date(p.demarre).toUTCString().replace("GMT", "+0000")}`); else l.push("      Reason:       ContainerCreating");
        l.push(`    Ready:          ${p.demarre ? "True" : "False"}`, "    Restart Count:  0", "    Environment:    <none>", "    Mounts:", `      /var/run/secrets/kubernetes.io/serviceaccount from kube-api-access-${suffixe()} (ro)`,
          "Conditions:", "  Type                        Status", `  PodReadyToStartContainers   ${p.demarre ? "True" : "False"} `, "  Initialized                 True ", `  Ready                       ${p.demarre ? "True" : "False"} `, `  ContainersReady             ${p.demarre ? "True" : "False"} `, "  PodScheduled                True ",
          "Volumes:", "  kube-api-access-xxxxx:", "    Type:                    Projected (a volume that contains injected data from multiple sources)", "QoS Class:                   BestEffort", "Node-Selectors:              <none>",
          "Tolerations:                 node.kubernetes.io/not-ready:NoExecute op=Exists for 300s", "                             node.kubernetes.io/unreachable:NoExecute op=Exists for 300s", "Events:", "  Type    Reason     Age   From               Message", "  ----    ------     ----  ----               -------",
          `  Normal  Scheduled  ${age(H.now() - p.cree)}    default-scheduler  Successfully assigned ${p.metadata.namespace}/${p.metadata.name} to minikube`, `  Normal  Pulled     ${age(H.now() - p.cree)}    kubelet            Container image "${c0.image}" already present on machine`,
          `  Normal  Created    ${age(H.now() - p.cree)}    kubelet            Created container: ${c0.name}`, `  Normal  Started    ${age(H.now() - p.cree)}    kubelet            Started container ${c0.name}`);
      } else if (type.kind === "Secret" || type.kind === "ConfigMap") {
        tete("Name", ob.metadata.name); tete("Namespace", ob.metadata.namespace); const lb = labels(ob.metadata.labels); tete("Labels", lb[0]); lb.slice(1).forEach((v) => l.push(v)); tete("Annotations", "<none>"); l.push("");
        if (type.kind === "Secret") {
          l.push(`Type:  ${ob.type || "Opaque"}`, "", "Data", "====");
          const keys = Object.keys(ob.data || {}).sort(); const w = Math.max(...keys.map((k) => k.length)) + 2;
          keys.forEach((k) => l.push(`${O.pad(k + ":", w)}  ${atob(ob.data[k]).length} bytes`));
        } else {
          l.push("Data", "====");
          Object.entries(ob.data || {}).forEach(([k, v]) => l.push(`${k}:`, "----", v, ""));
          l.push("", "BinaryData", "====", "", "Events:  <none>");
        }
      } else if (type.kind === "Deployment") {
        const d = ob; const c0 = d.spec.template.spec.containers[0];
        tete("Name", d.metadata.name); tete("Namespace", d.metadata.namespace); tete("CreationTimestamp", new Date(d.cree).toUTCString().replace("GMT", "+0000"));
        const lb = labels(d.metadata.labels); tete("Labels", lb[0]); lb.slice(1).forEach((v) => l.push(v));
        tete("Annotations", `deployment.kubernetes.io/revision: ${Math.max(0, ...K.rsDe(d).map((rs) => +rs.metadata.annotations["deployment.kubernetes.io/revision"]))}`);
        tete("Selector", Object.entries(d.spec.selector.matchLabels).map(([k, v]) => `${k}=${v}`).join(","));
        tete("Replicas", `${d.spec.replicas} desired | ${d.status.updatedReplicas || 0} updated | ${d.status.replicas || 0} total | ${d.status.availableReplicas || 0} available | ${d.status.unavailableReplicas || 0} unavailable`);
        tete("StrategyType", (d.spec.strategy || {}).type || "RollingUpdate"); tete("MinReadySeconds", "0");
        l.push("Pod Template:", `  Labels:  ${Object.entries(d.spec.template.metadata.labels).map(([k, v]) => `${k}=${v}`).join(",")}`, "  Containers:", `   ${c0.name}:`, `    Image:         ${c0.image}`, `    Port:          ${(c0.ports || [])[0] ? c0.ports[0].containerPort + "/TCP" : "<none>"}`);
        const neuf = K.rsDe(d).find((rs) => rs.metadata.labels["pod-template-hash"] === K.hashGabarit(d.spec.template));
        l.push("Conditions:", "  Type           Status  Reason", "  ----           ------  ------", "  Available      True    MinimumReplicasAvailable", "  Progressing    True    NewReplicaSetAvailable", `OldReplicaSets:  ${K.rsDe(d).filter((rs) => rs !== neuf && rs.spec.replicas).map((rs) => rs.metadata.name).join(", ") || "<none>"}`, `NewReplicaSet:   ${neuf ? `${neuf.metadata.name} (${neuf.status.replicas || 0}/${neuf.spec.replicas} replicas created)` : "<none>"}`);
      } else if (type.kind === "Service") {
        const s = ob; tete("Name", s.metadata.name); tete("Namespace", s.metadata.namespace); const lb = labels(s.metadata.labels); tete("Labels", lb[0]); lb.slice(1).forEach((v) => l.push(v));
        tete("Annotations", "<none>"); tete("Selector", s.spec.selector ? Object.entries(s.spec.selector).map(([k, v]) => `${k}=${v}`).join(",") : "<none>"); tete("Type", s.spec.type || "ClusterIP"); tete("IP Family Policy", "SingleStack"); tete("IP Families", "IPv4"); tete("IP", s.spec.clusterIP); tete("IPs", s.spec.clusterIP);
        const p = (s.spec.ports || [])[0] || {}; tete("Port", `<unset>  ${p.port}/TCP`); tete("TargetPort", `${p.targetPort || p.port}/TCP`); if (p.nodePort) tete("NodePort", `<unset>  ${p.nodePort}/TCP`);
        const eps = K.liste("EndpointSlice", s.metadata.namespace).find((e) => e.metadata.labels["kubernetes.io/service-name"] === s.metadata.name);
        tete("Endpoints", eps && eps.endpoints.length ? eps.endpoints.map((e) => `${e.ip}:${p.targetPort || p.port}`).join(",") : ""); tete("Session Affinity", "None"); tete("Internal Traffic Policy", "Cluster"); tete("Events", "<none>");
      } else {
        tete("Name", ob.metadata.name); if (ob.metadata.namespace) tete("Namespace", ob.metadata.namespace); const lb = labels(ob.metadata.labels); tete("Labels", lb[0]); lb.slice(1).forEach((v) => l.push(v)); tete("Annotations", "<none>");
        if (type.kind === "Node") { tete("Roles", "control-plane"); tete("CreationTimestamp", new Date(K.creeA).toUTCString().replace("GMT", "+0000")); l.push("Addresses:", `  InternalIP:  ${IP_NOEUD}`, "  Hostname:    minikube", "System Info:", "  Kernel Version:             " + SIM.noyauVersion, "  OS Image:                   Debian GNU/Linux 12 (bookworm)", "  Container Runtime Version:  containerd://2.3.4", "  Kubelet Version:            v1.37.0"); }
        if (type.kind === "PersistentVolumeClaim") { tete("StorageClass", "standard"); tete("Status", (ob.status || {}).phase || "Pending"); tete("Volume", ob.spec.volumeName || ""); tete("Capacity", ((ob.status || {}).capacity || {}).storage || ""); tete("Access Modes", "RWO"); }
      }
    });
    return R.ok(l);
  };

  // Valeurs par défaut posées par l'API (pour kubectl diff et -o yaml).
  function defauts(ob) {
    if (ob.kind === "Deployment") {
      ob.spec = Object.assign({ progressDeadlineSeconds: 600, replicas: 1, revisionHistoryLimit: 10 }, ob.spec);
      ob.spec.strategy = ob.spec.strategy || { type: "RollingUpdate" };
      if ((ob.spec.strategy.type || "RollingUpdate") === "RollingUpdate") { ob.spec.strategy.type = "RollingUpdate"; ob.spec.strategy.rollingUpdate = Object.assign({ maxSurge: "25%", maxUnavailable: "25%" }, ob.spec.strategy.rollingUpdate); }
      const tpl = ob.spec.template; tpl.metadata = Object.assign({ creationTimestamp: null }, tpl.metadata);
      tpl.spec = Object.assign({ dnsPolicy: "ClusterFirst", restartPolicy: "Always", schedulerName: "default-scheduler", securityContext: {}, terminationGracePeriodSeconds: 30 }, tpl.spec);
      tpl.spec.containers = tpl.spec.containers.map((c) => Object.assign({ imagePullPolicy: /:latest$|^[^:]+$/.test(c.image) ? "Always" : "IfNotPresent", resources: {}, terminationMessagePath: "/dev/termination-log", terminationMessagePolicy: "File" }, c, { ports: c.ports ? c.ports.map((p) => Object.assign({ protocol: "TCP" }, p)) : undefined }));
      tpl.spec.containers.forEach((c) => { if (!c.ports) delete c.ports; });
    }
    if (ob.kind === "Service") {
      ob.spec = Object.assign({ type: "ClusterIP", sessionAffinity: "None", ipFamilies: ["IPv4"], ipFamilyPolicy: "SingleStack", internalTrafficPolicy: "Cluster" }, ob.spec);
      if (!ob.spec.clusterIP) { ob.spec.clusterIP = `10.${[96, 97, 98, 100, 104, 108][Math.floor(Math.random() * 6)]}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 2}`; ob.spec.clusterIPs = [ob.spec.clusterIP]; }
      ob.spec.ports = (ob.spec.ports || []).map((p) => Object.assign({ protocol: "TCP", targetPort: p.port }, p, ob.spec.type === "NodePort" && !p.nodePort ? { nodePort: 30000 + Math.floor(Math.random() * 2767) } : {}));
    }
    if (ob.kind === "Secret") { ob.type = ob.type || "Opaque"; if (ob.stringData) { ob.data = Object.assign({}, ob.data, Object.fromEntries(Object.entries(ob.stringData).map(([k, v]) => [k, btoa(String(v))]))); delete ob.stringData; } }
    if (ob.kind === "PersistentVolumeClaim") { ob.spec = Object.assign({ storageClassName: "standard", volumeMode: "Filesystem" }, ob.spec); ob.status = { phase: "Pending" }; }
    return ob;
  }
  function etiquetteRes(type, nom) { return `${type.prefixe}/${nom}`; }

  // Applique (crée ou met à jour) un objet ; renvoie le verbe : created, configured, unchanged.
  function appliquer(doc, nsDefaut, avertir) {
    const type = typeKind(doc.kind);
    if (!type) return { erreur: `error: resource mapping not found for name: "${(doc.metadata || {}).name}" namespace: "" from "": no matches for kind "${doc.kind}" in version "${doc.apiVersion}"` };
    const ns = type.global ? undefined : (doc.metadata.namespace || nsDefaut);
    if (ns && !K.nsExiste(ns)) return { erreur: `Error from server (NotFound): error when creating "${avertir.fichier}": namespaces "${ns}" not found` };
    const trie = (v) => (Array.isArray(v) ? v.map(trie) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, trie(v[k])])) : v);
    const dernier = JSON.stringify(trie(Object.assign({}, doc, { metadata: Object.assign({ annotations: {} }, doc.metadata, { namespace: ns }) })));
    const ex = K.trouver(doc.kind, ns, doc.metadata.name);
    if (!ex) {
      if (doc.kind === "Namespace") { K.ajouterNs(doc.metadata.name); return { verbe: "created", type }; }
      const ob = defauts(clone(doc)); ob.metadata.namespace = ns; ob.metadata.annotations = Object.assign({}, ob.metadata.annotations, { "kubectl.kubernetes.io/last-applied-configuration": dernier + "\n" });
      if (ob.kind === "Deployment") { ob.metadata.generation = 1; ob.status = {}; }
      K.ajouter(ob);
      return { verbe: "created", type };
    }
    const avant = JSON.stringify([ex.spec, ex.data, ex.metadata.labels]);
    const neuf = defauts(clone(doc));
    if (ex.kind === "Secret" && !(ex.metadata.annotations || {})["kubectl.kubernetes.io/last-applied-configuration"]) avertir.l.push({ t: `Warning: resource secrets/${ex.metadata.name} is missing the kubectl.kubernetes.io/last-applied-configuration annotation which is required by kubectl apply. kubectl apply should only be used on resources created declaratively by either kubectl create --save-config or kubectl apply. The missing annotation will be patched automatically.`, e: true });
    if (neuf.spec) { if (ex.kind === "Service") neuf.spec.clusterIP = ex.spec.clusterIP; ex.spec = Object.assign({}, ex.kind === "PersistentVolumeClaim" ? ex.spec : {}, neuf.spec); }
    if (neuf.data !== undefined) ex.data = neuf.data;
    if (neuf.metadata.labels) ex.metadata.labels = neuf.metadata.labels;
    ex.metadata.annotations = Object.assign({}, ex.metadata.annotations, { "kubectl.kubernetes.io/last-applied-configuration": dernier + "\n" });
    const apres = JSON.stringify([ex.spec, ex.data, ex.metadata.labels]);
    if (avant === apres) return { verbe: "unchanged", type };
    if (ex.kind === "Deployment") ex.metadata.generation = (ex.metadata.generation || 1) + 1;
    ex.metadata.resourceVersion = String(++K.version);
    return { verbe: "configured", type };
  }
  function lireManifestes(x, fichiers) {
    const docs = [];
    for (const f of fichiers) {
      let txt;
      if (f === "-") txt = (x.stdin || []).join("\n");
      else {
        const p = chemin.norm(f, x.sh.cwd); const st = x.fs.stat(p);
        if (!st) return { erreur: `error: the path "${f}" does not exist` };
        if (st.type === "d") { const l = x.fs.lister(p).noms.filter((n) => /\.(ya?ml|json)$/.test(n)); for (const n of l) docs.push(...lireManifestes(x, [f.replace(/\/$/, "") + "/" + n]).docs.map((d) => d)); continue; }
        txt = x.fs.lire(p).contenu;
      }
      try { yaml().loadAll(txt, (d) => { if (d) docs.push({ d, f }); }); } catch (e) { return { erreur: `error: error parsing ${f}: error converting YAML to JSON: yaml: line ${(e.mark && e.mark.line + 1) || 1}: ${e.reason || e.message}` }; }
    }
    return { docs };
  }
  KC.apply = (x, o) => {
    if (!o.fichiers.length) return R.err(["error: must specify one of -f and -k", "", "See 'kubectl apply -h' for help and examples"], 1);
    const lu = lireManifestes(x, o.fichiers);
    if (lu.erreur) return R.err(lu.erreur, 1);
    const l = []; let code = 0;
    for (const { d, f } of lu.docs) {
      if (!d.kind || !d.metadata || !d.metadata.name) { l.push({ t: `error: error validating "${f}": error validating data: [apiVersion not set, kind not set]; if you choose to ignore these errors, turn validation off with --validate=false`, e: true }); code = 1; continue; }
      if (o.dryRun) { l.push({ t: `${etiquetteRes(typeKind(d.kind) || { prefixe: d.kind.toLowerCase() }, d.metadata.name)} created (dry run)` }); continue; }
      const r = appliquer(d, o.ns || "default", { l, fichier: f });
      if (r.erreur) { l.push({ t: r.erreur, e: true }); code = 1; continue; }
      l.push({ t: `${etiquetteRes(r.type, d.metadata.name)} ${r.verbe}` });
    }
    SIM.tic();
    return { l, code };
  };
  KC.create = (x, o) => {
    const [quoi, ...reste] = o.ops;
    const ns = nsDe(o);
    const sortieDry = (ob) => (o.sortie === "yaml" ? yaml().dump(ob, { sortKeys: true, noArrayIndent: true, lineWidth: -1, quotingType: '"' }).replace(/\n$/, "").split("\n") : o.sortie === "json" ? JSON.stringify(ob, null, 4).split("\n") : [`${etiquetteRes(typeKind(ob.kind), ob.metadata.name)} created (dry run)`]);
    const verifNs = (verbe) => (K.nsExiste(ns) ? null : R.err(`error: failed to create ${verbe}: namespaces "${ns}" not found`, 1));
    if (quoi === "namespace" || quoi === "ns") {
      const n = reste[0];
      if (o.dryRun) return R.ok(sortieDry({ apiVersion: "v1", kind: "Namespace", metadata: { creationTimestamp: null, name: n }, spec: {}, status: {} }));
      if (K.trouver("Namespace", null, n)) return R.err(`Error from server (AlreadyExists): namespaces "${n}" already exists`, 1);
      K.ajouterNs(n); return R.ok(`namespace/${n} created`);
    }
    if (quoi === "configmap" || quoi === "cm") {
      const n = reste[0]; const data = {};
      o.lit.forEach((kv) => { const k = kv.indexOf("="); data[kv.slice(0, k)] = kv.slice(k + 1); });
      for (const f of o.fichiersCm) { const [cle, chem] = f.includes("=") ? f.split("=") : [chemin.base(f), f]; const r = x.fs.lire(chemin.norm(chem, x.sh.cwd)); if (r.err) return R.err(`error: error reading ${chem}: no such file or directory`, 1); data[cle] = r.contenu; }
      const ob = { apiVersion: "v1", data, kind: "ConfigMap", metadata: { creationTimestamp: null, name: n, namespace: o.ns || undefined } };
      if (o.dryRun) return R.ok(sortieDry(ob));
      const e = verifNs("configmap"); if (e) return e;
      if (K.trouver("ConfigMap", ns, n)) return R.err(`error: failed to create configmap: configmaps "${n}" already exists`, 1);
      delete ob.metadata.creationTimestamp; ob.metadata.namespace = ns; K.ajouter(ob); return R.ok(`configmap/${n} created`);
    }
    if (quoi === "secret") {
      const [genre, n] = reste;
      if (genre !== "generic") return R.err(`(simulateur : seul « kubectl create secret generic » est simulé.)`, 1);
      const data = {};
      o.lit.forEach((kv) => { const k = kv.indexOf("="); data[kv.slice(0, k)] = btoa(kv.slice(k + 1)); });
      for (const f of o.fichiersCm) { const [cle, chem] = f.includes("=") ? f.split("=") : [chemin.base(f), f]; const r = x.fs.lire(chemin.norm(chem, x.sh.cwd)); if (r.err) return R.err(`error: error reading ${chem}: no such file or directory`, 1); data[cle] = btoa(r.contenu); }
      const ob = { apiVersion: "v1", data, kind: "Secret", metadata: { creationTimestamp: null, name: n, namespace: o.ns || undefined } };
      if (o.dryRun) return R.ok(sortieDry(ob));
      const e = verifNs("secret"); if (e) return e;
      if (K.trouver("Secret", ns, n)) return R.err(`error: failed to create secret secrets "${n}" already exists`, 1);
      delete ob.metadata.creationTimestamp; ob.metadata.namespace = ns; ob.type = "Opaque"; K.ajouter(ob); return R.ok(`secret/${n} created`);
    }
    if (quoi === "deployment" || quoi === "deploy") {
      const n = reste[0];
      if (!o.image) return R.err(["error: required flag(s) \"image\" not set"], 1);
      const nomC = D.Moteur.ref(o.image).repo.split("/").pop();
      const ob = { apiVersion: "apps/v1", kind: "Deployment", metadata: { labels: { app: n }, name: n, namespace: ns }, spec: { replicas: o.replicas || 1, selector: { matchLabels: { app: n } }, strategy: {}, template: { metadata: { labels: { app: n } }, spec: { containers: [Object.assign({ image: o.image, name: nomC, resources: {} }, o.port ? { ports: [{ containerPort: parseInt(o.port, 10) }] } : {})] } } } };
      if (o.dryRun) return R.ok(sortieDry(ob));
      const e = verifNs("deployment"); if (e) return e;
      if (K.trouver("Deployment", ns, n)) return R.err(`error: failed to create deployment: deployments.apps "${n}" already exists`, 1);
      const d = defauts(ob); d.metadata.generation = 1; d.status = {}; K.ajouter(d); SIM.tic();
      return R.ok(`deployment.apps/${n} created`);
    }
    if (!quoi && o.fichiers.length) {
      const lu = lireManifestes(x, o.fichiers); if (lu.erreur) return R.err(lu.erreur, 1);
      const l = []; let code = 0;
      for (const { d, f } of lu.docs) {
        if (K.trouver(d.kind, typeKind(d.kind).global ? undefined : d.metadata.namespace || ns, d.metadata.name)) { l.push({ t: `Error from server (AlreadyExists): error when creating "${f}": ${typeKind(d.kind).groupe} "${d.metadata.name}" already exists`, e: true }); code = 1; continue; }
        const r = appliquer(d, ns, { l, fichier: f }); if (r.erreur) { l.push({ t: r.erreur, e: true }); code = 1; continue; }
        const ob = K.trouver(d.kind, typeKind(d.kind).global ? undefined : d.metadata.namespace || ns, d.metadata.name); if (ob && ob.metadata.annotations) delete ob.metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"];
        l.push({ t: `${etiquetteRes(r.type, d.metadata.name)} created` });
      }
      SIM.tic(); return { l, code };
    }
    return R.err(`(simulateur : « kubectl create ${quoi || ""} » n'est pas simulé ; utilise namespace, deployment, configmap, secret generic ou -f.)`, 1);
  };
  // Attend la fin d'un rollout en temps virtuel, avec les messages de kubectl rollout status.
  function suivreRollout(d, l, maxMs = 180000) {
    const nom = d.metadata.name; let ecoule = 0; let dernier = null;
    for (let k = 0; k < 300; k++) {
      K.avancer(H.now());
      const voulu = d.spec.replicas ?? 1; const s = d.status;
      let msg;
      if ((s.updatedReplicas || 0) < voulu) msg = `Waiting for deployment "${nom}" rollout to finish: ${s.updatedReplicas || 0} out of ${voulu} new replicas have been updated...`;
      else if ((s.replicas || 0) > (s.updatedReplicas || 0) || s.terminants && (d.spec.strategy || {}).type === "Recreate" && false) msg = `Waiting for deployment "${nom}" rollout to finish: ${(s.replicas || 0) - (s.updatedReplicas || 0)} old replicas are pending termination...`;
      else if ((s.availableReplicas || 0) < (s.updatedReplicas || 0)) msg = `Waiting for deployment "${nom}" rollout to finish: ${s.availableReplicas || 0} of ${s.updatedReplicas || 0} updated replicas are available...`;
      else { l.push({ t: `deployment "${nom}" successfully rolled out` }); return 0; }
      if (msg !== dernier || Math.random() < 0.35) { l.push({ t: msg }); dernier = msg; }
      const t = K.prochainEvenement();
      if (t === Infinity || ecoule > maxMs) { l.push({ t: `error: timed out waiting for the condition`, e: true }); return 1; }
      const pas = Math.max(50, t - H.now() + 5);
      l.push({ pause: pas }); H.avancer(pas); ecoule += pas;
    }
    return 1;
  }
  KC.rollout = (x, o) => {
    const [action, cible] = o.ops;
    const [t, n] = (cible || "").includes("/") ? cible.split("/") : [cible, o.ops[2]];
    const ns = nsDe(o);
    const d = K.trouver("Deployment", ns, n);
    if (!typeDe(t || "") || typeDe(t).kind !== "Deployment") return R.err(`error: no kind "${t}" is registered for the rollout ${action}`, 1);
    if (!d) return R.err(`Error from server (NotFound): deployments.apps "${n}" not found`, 1);
    const l = [];
    if (action === "status") { const code = suivreRollout(d, l, o.timeout ? D.dureeMs(o.timeout) : 600000); return { l, code }; }
    if (action === "history") {
      const revs = K.rsDe(d).map((rs) => +rs.metadata.annotations["deployment.kubernetes.io/revision"]).sort((a, b) => a - b);
      return R.ok([`deployment.apps/${n} `, "REVISION  CHANGE-CAUSE"].concat(revs.map((r) => O.pad(r, 10) + "<none>")).concat([""]));
    }
    if (action === "undo") {
      const rss = K.rsDe(d).sort((a, b) => +b.metadata.annotations["deployment.kubernetes.io/revision"] - +a.metadata.annotations["deployment.kubernetes.io/revision"]);
      const cibleRs = o.revision ? rss.find((rs) => rs.metadata.annotations["deployment.kubernetes.io/revision"] === String(o.revision)) : rss[1];
      if (!cibleRs) return R.err(`error: no rollout history found for deployment "${n}"`, 1);
      if (d.metadata.annotations && d.metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"]) l.push({ t: `Warning: resource deployments/${n} was previously managed with 'kubectl apply'. Rolling back will not update the kubectl.kubernetes.io/last-applied-configuration annotation, which may cause unexpected behavior on future 'kubectl apply' operations. Consider using 'kubectl apply' with your previous configuration file instead.`, e: true });
      const tpl = clone(cibleRs.spec.template); delete tpl.metadata.labels["pod-template-hash"];
      d.spec.template = tpl; d.metadata.generation++;
      const max = Math.max(...rss.map((rs) => +rs.metadata.annotations["deployment.kubernetes.io/revision"]));
      cibleRs.metadata.annotations["deployment.kubernetes.io/revision"] = String(max + 1);
      d.revisionVue = true;
      l.push({ t: `deployment.apps/${n} rolled back` }); SIM.tic(); return { l, code: 0 };
    }
    if (action === "restart") {
      d.spec.template.metadata.annotations = Object.assign({}, d.spec.template.metadata.annotations, { "kubectl.kubernetes.io/restartedAt": iso(H.now()) });
      d.metadata.generation++; SIM.tic(); return R.ok(`deployment.apps/${n} restarted`);
    }
    if (action === "pause" || action === "resume") return R.ok(`deployment.apps/${n} ${action}d`);
    return R.err(`error: unknown command "${action}" for "kubectl rollout"`, 1);
  };
  KC.scale = (x, o) => {
    const [cible] = o.ops; const [t, n] = cible.includes("/") ? cible.split("/") : [cible, o.ops[1]];
    const type = typeDe(t || ""); const ns = nsDe(o);
    const ob = type && K.trouver(type.kind, ns, n);
    if (!ob) return R.err(`Error from server (NotFound): ${type ? type.groupe : t} "${n}" not found`, 1);
    if (o.replicas === undefined || isNaN(o.replicas)) return R.err("error: required flag(s) \"replicas\" not set", 1);
    ob.spec.replicas = o.replicas; if (ob.kind === "Deployment") ob.metadata.generation++;
    SIM.tic(); return R.ok(`${type.prefixe}/${n} scaled`);
  };
  KC.set = (x, o) => {
    const [quoi, cible, ...affect] = o.ops;
    if (quoi !== "image") return R.err(`(simulateur : seul « kubectl set image » est simulé.)`, 1);
    const [t, n] = cible.includes("/") ? cible.split("/") : [cible, affect.shift()];
    const d = K.trouver("Deployment", nsDe(o), n);
    if (!d) return R.err(`Error from server (NotFound): deployments.apps "${n}" not found`, 1);
    void t;
    for (const a of affect) {
      const [c, img] = a.split("=");
      const ct = d.spec.template.spec.containers.find((y) => y.name === c || c === "*");
      if (!ct) return R.err(`error: unable to find container named "${c}"`, 1);
      ct.image = img;
    }
    d.metadata.generation++; SIM.tic();
    return R.ok(`deployment.apps/${n} image updated`);
  };
  KC.expose = (x, o) => {
    const [cible] = o.ops; const [t, n] = cible.includes("/") ? cible.split("/") : [cible, o.ops[1]];
    const ns = nsDe(o); const type = typeDe(t || "");
    const src = type && K.trouver(type.kind, ns, n);
    if (!src) return R.err(`Error from server (NotFound): ${type ? type.groupe : t} "${n}" not found`, 1);
    const sel = src.kind === "Deployment" ? src.spec.selector.matchLabels : src.metadata.labels;
    const port = parseInt(o.port || ((src.spec.template || src).spec.containers[0].ports || [{}])[0].containerPort, 10);
    if (!port) return R.err(`error: couldn't find port via --port flag or introspection`, 1);
    const nom = o.nom || n;
    if (K.trouver("Service", ns, nom)) return R.err(`Error from server (AlreadyExists): services "${nom}" already exists`, 1);
    const s = defauts({ apiVersion: "v1", kind: "Service", metadata: { name: nom, namespace: ns, labels: Object.assign({}, src.metadata.labels) }, spec: { type: o.type || "ClusterIP", selector: sel, ports: [{ port, protocol: "TCP", targetPort: parseInt(o.targetPort || port, 10) }] } });
    K.ajouter(s); SIM.tic();
    return R.ok(`service/${nom} exposed`);
  };
  KC.delete = (x, o) => {
    const ns = nsDe(o); const l = []; let code = 0;
    let cibles = [];
    if (o.fichiers.length) { const lu = lireManifestes(x, o.fichiers); if (lu.erreur) return R.err(lu.erreur, 1); cibles = lu.docs.map(({ d }) => ({ type: typeKind(d.kind), n: d.metadata.name, ns: d.metadata.namespace || ns })); }
    else if (o.ops[0] && o.ops[0].includes("/")) cibles = o.ops.map((s) => { const [t, n] = s.split("/"); return { type: typeDe(t), n, ns }; });
    else if (o.ops[0]) {
      const types = o.ops[0].split(",").map(typeDe);
      if (types.some((t) => !t)) return R.err(`error: the server doesn't have a resource type "${o.ops[0]}"`, 1);
      if (o.sel || o.ops.includes("--all")) types.forEach((t) => K.liste(t.kind, t.global ? null : ns, o.sel).forEach((ob) => cibles.push({ type: t, n: ob.metadata.name, ns })));
      else o.ops.slice(1).forEach((n) => types.forEach((t) => cibles.push({ type: t, n, ns })));
      if (!cibles.length && o.sel) return R.err("No resources found", 0);
    } else return R.err(["error: You must provide one or more resources by argument or filename.", "Example resource specifications include:", "   '-f rsrc.yaml'", "   '--filename=rsrc.json'", "   '<resource> <name>'", "   '<resource>'"], 1);
    const attente = [];
    for (const c of cibles) {
      if (!c.type) { l.push({ t: `error: the server doesn't have a resource type`, e: true }); code = 1; continue; }
      const ob = K.trouver(c.type.kind, c.type.global ? null : c.ns, c.n);
      if (!ob || ob.suppression) { l.push({ t: `Error from server (NotFound): ${c.type.groupe} "${c.n}" not found`, e: true }); code = 1; continue; }
      if (ob.kind === "Namespace") { if (["default", "kube-system", "kube-public", "kube-node-lease"].includes(c.n)) { l.push({ t: `Error from server (Forbidden): namespaces "${c.n}" is forbidden: this namespace may not be deleted`, e: true }); code = 1; continue; } K.supprimerNs(ob); attente.push(ob); l.push({ t: `namespace "${c.n}" deleted`, attente: ob }); continue; }
      if (ob.kind === "Pod") { K.supprimerPod(ob, o.force ? 0 : undefined); attente.push(ob); l.push({ t: `pod "${c.n}" deleted from ${c.ns} namespace`, attente: ob }); continue; }
      if (ob.kind === "Deployment") K.rsDe(ob).forEach((rs) => { K.podsDe(rs).forEach((p) => K.supprimerPod(p)); K.retirer(rs); });
      if (ob.kind === "ReplicaSet") K.podsDe(ob).forEach((p) => K.supprimerPod(p));
      if (ob.kind === "Service") K.liste("EndpointSlice", c.ns).filter((e) => e.metadata.labels["kubernetes.io/service-name"] === c.n).forEach((e) => K.retirer(e));
      if (ob.kind === "PersistentVolumeClaim") K.liste("PersistentVolume", null).filter((pv) => pv.spec.claimRef && pv.spec.claimRef.name === c.n && pv.spec.claimRef.namespace === c.ns).forEach((pv) => K.retirer(pv));
      K.retirer(ob);
      l.push({ t: `${c.type.prefixe.split(".")[0]} "${c.n}" deleted from ${c.ns} namespace`.replace(/ from undefined namespace$/, "") });
    }
    // --wait (par défaut) : la commande rend la main quand les objets ont disparu.
    if (o.wait !== false && attente.length) {
      const out = [];
      for (const x2 of l) {
        if (x2.attente) {
          const ob = x2.attente; let ecoule = 0;
          while (K.objets.includes(ob) && ecoule < 60000) { const t = K.prochainEvenement(); const pas = t === Infinity ? 500 : Math.max(50, t - H.now() + 5); out.push({ pause: pas }); H.avancer(pas); ecoule += pas; }
        }
        out.push({ t: x2.t, e: x2.e });
      }
      return { l: out, code };
    }
    return { l: l.map((y) => ({ t: y.t, e: y.e })), code };
  };
  KC.run = (x, o) => {
    const n = o.ops[0]; const ns = nsDe(o);
    if (!o.image) return R.err("error: required flag(s) \"image\" not set", 1);
    if (!K.nsExiste(ns)) return R.err(`Error from server (NotFound): namespaces "${ns}" not found`, 1);
    if (K.trouver("Pod", ns, n)) return R.err(`Error from server (AlreadyExists): pods "${n}" already exists`, 1);
    const cmd = o.apres || [];
    const p = K.creerPod(null, { nom: n, ns, template: { metadata: { labels: { run: n } }, spec: { restartPolicy: o.restart || "Always", containers: [Object.assign({ name: n, image: o.image }, cmd.length ? { args: cmd } : {})] } } });
    if (!o.it && !o.rm) { SIM.tic(); return R.ok(`pod/${n} created`); }
    const l = [];
    let ecoule = 0;
    while (!p.demarre && ecoule < 60000) { const t = K.prochainEvenement(); const pas = t === Infinity ? 500 : Math.max(50, t - H.now() + 5); l.push({ pause: pas }); H.avancer(pas); ecoule += pas; }
    if (o.it) l.push({ t: "All commands and output from this session will be recorded in container logs, including credentials and sensitive information passed through the command prompt." }, { t: "If you don't see a command prompt, try pressing enter." });
    const c = p.conteneur;
    if (c && c.etat !== "running" && cmd.length) l.push({ t: `warning: couldn't attach to pod/${n}, falling back to streaming logs: unable to upgrade connection: container ${n} not found in pod ${n}_${ns}`, e: true });
    if (c) c.logs.forEach((y) => l.push({ t: y.t, e: y.e }));
    if (c && c.etat === "running" && !cmd.length) l.push({ t: "(simulateur : pas de shell interactif dans un pod ; donne une commande après -- , par exemple -- wget -qO- http://web)", e: true, info: true });
    if (o.rm) { K.retirer(p); l.push({ t: `pod "${n}" deleted from ${ns} namespace` }); }
    return { l, code: c ? (c.etat === "running" ? 0 : c.code) : 1 };
  };
  KC.logs = (x, o) => {
    const cible = o.ops[0] || ""; const ns = nsDe(o);
    let p;
    if (cible.includes("/")) { const [t, n] = cible.split("/"); const type = typeDe(t); if (type && type.kind === "Deployment") { const d = K.trouver("Deployment", ns, n); p = d && K.rsDe(d).flatMap((rs) => K.podsDe(rs)).find((y) => y.conteneur); } else p = K.trouver("Pod", ns, n); }
    else p = K.trouver("Pod", ns, cible);
    if (!p) return R.err(`Error from server (NotFound): pods "${cible.split("/").pop()}" not found`, 1);
    if (!p.conteneur) return R.err(`Error from server (BadRequest): container "${p.spec.containers[0].name}" in pod "${p.metadata.name}" is waiting to start: ContainerCreating`, 1);
    return R.ok(p.conteneur.logs.map((y) => y.t));
  };
  KC.exec = (x, o) => {
    const cible = o.ops[0] || ""; const ns = nsDe(o);
    const n = cible.replace(/^pods?\//, "");
    const p = K.trouver("Pod", ns, n);
    if (!p) return R.err(`Error from server (NotFound): pods "${n}" not found`, 1);
    if (!p.conteneur || p.conteneur.etat !== "running") return R.err(`error: unable to upgrade connection: container not found ("${p.spec.containers[0].name}")`, 1);
    if (!o.apres || !o.apres.length) return R.err("error: you must specify at least one command for the container", 1);
    return D.executerDans(K.noeud, p.conteneur, o.apres, {});
  };
  KC["port-forward"] = (x, o) => {
    const [cible, paire] = o.ops; const ns = nsDe(o);
    const [t, n] = (cible || "").includes("/") ? cible.split("/") : ["pod", cible];
    const [local, distant0] = String(paire || "").split(":");
    const type = typeDe(t);
    const ob = type && K.trouver(type.kind, ns, n);
    if (!ob) return R.err(`Error from server (NotFound): ${type ? type.groupe : t} "${n}" not found`, 1);
    if (K.forwards.some((f) => String(f.local) === String(local))) return R.err([`Unable to listen on port ${local}: Listeners failed to create with the following errors: [unable to create listener: Error listen tcp4 127.0.0.1:${local}: bind: address already in use unable to create listener: Error listen tcp6 [::1]:${local}: bind: address already in use]`, `error: unable to listen on any of the requested ports: [{${local} ${distant0 || local}}]`], 1);
    let distant = distant0 || local;
    if (ob.kind === "Service") { const sp = (ob.spec.ports || []).find((p) => String(p.port) === String(distant)) || ob.spec.ports[0]; distant = String(sp.targetPort || sp.port); }
    const podChoisi = () => {
      if (ob.kind === "Pod") return ob;
      const sel = ob.kind === "Service" ? ob.spec.selector : ob.spec.selector.matchLabels;
      return K.liste("Pod", ns, sel).find((p) => p.demarre && !p.suppression && p.conteneur);
    };
    const job = x.sh.jobCourant;
    const f = { local, distant, pod: podChoisi, journal: (t2) => SIM.fondEnAttente.push({ t: t2 }), arreter: () => { K.forwards = K.forwards.filter((y) => y !== f); } };
    K.forwards.push(f);
    if (job) job.arreter = f.arreter;
    const l = [{ t: `Forwarding from 127.0.0.1:${local} -> ${distant}` }, { t: `Forwarding from [::1]:${local} -> ${distant}` }];
    if (!job) l.push({ t: "(simulateur : en vrai, port-forward occupe le terminal jusqu'à Ctrl+C. Ici il reste actif en arrière-plan ; lance-le avec & à la fin pour le gérer avec kill %1.)", e: true, info: true });
    return { l, code: 0 };
  };
  KC.diff = (x, o) => {
    const lu = lireManifestes(x, o.fichiers);
    if (lu.erreur) return R.err(lu.erreur, 1);
    const l = []; let diff = false;
    const dump = (ob) => yaml().dump(ob, { sortKeys: true, noArrayIndent: true, lineWidth: -1, quotingType: '"' }).replace(/\n$/, "").split("\n");
    for (const { d } of lu.docs) {
      const type = typeKind(d.kind); const ns = type.global ? undefined : d.metadata.namespace || nsDe(o);
      const ex = K.trouver(d.kind, ns, d.metadata.name);
      const vivant = ex ? vueApi(ex) : null; if (vivant) delete vivant.status;
      let fusion = null;
      if (ex) {
        fusion = clone(vivant); const neuf = defauts(clone(d));
        if (neuf.spec) fusion.spec = Object.assign({}, fusion.spec, neuf.spec, ex.kind === "Service" ? { clusterIP: ex.spec.clusterIP } : {});
        if (neuf.data !== undefined) fusion.data = neuf.data;
        if (JSON.stringify(fusion.spec) !== JSON.stringify(vivant.spec) && ex.kind === "Deployment") fusion.metadata.generation = (vivant.metadata.generation || 1) + 1;
      } else { fusion = defauts(clone(d)); fusion.metadata.namespace = ns; }
      const a = vivant ? dump(vivant) : []; const b = dump(fusion);
      if (a.join("\n") === b.join("\n")) continue;
      diff = true;
      const base = `${(type.api.includes("/") ? type.api.replace("/", ".") : "v1")}.${d.kind}.${ns ? ns + "." : ""}${d.metadata.name}`;
      const nl = () => String(1e9 + Math.floor(Math.random() * 3e9));
      const dt = new Date(H.now()).toISOString().replace("T", " ").replace(/\.(\d{3})Z/, `.$1${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")} +0000`);
      const live = `/tmp/LIVE-${nl()}/${base}`; const merged = `/tmp/MERGED-${nl()}/${base}`;
      l.push({ t: `diff -u -N ${live} ${merged}` }, { t: `--- ${live}\t${dt}` }, { t: `+++ ${merged}\t${dt}` });
      unifie(a, b).forEach((t) => l.push({ t }));
    }
    return { l, code: diff ? 1 : 0 };
  };
  // Diff unifié (3 lignes de contexte) entre deux listes de lignes.
  function unifie(a, b) {
    const n = a.length; const m = b.length;
    const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const ops = []; let i = 0; let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) { ops.push([" ", a[i], i, j]); i++; j++; }
      else if (i < n && (j >= m || L[i + 1][j] >= L[i][j + 1])) { ops.push(["-", a[i], i, j]); i++; }
      else { ops.push(["+", b[j], i, j]); j++; }
    }
    const out = []; let k = 0;
    while (k < ops.length) {
      if (ops[k][0] === " ") { k++; continue; }
      let debut = Math.max(0, k - 3); let fin = k;
      while (fin < ops.length) { if (ops[fin][0] !== " ") { fin++; continue; } let c = fin; while (c < ops.length && ops[c][0] === " ") c++; if (c - fin > 6 || c === ops.length) { fin = Math.min(ops.length, fin + 3); break; } fin = c; }
      const morceau = ops.slice(debut, fin);
      const ia = morceau.filter((y) => y[0] !== "+").length; const ib = morceau.filter((y) => y[0] !== "-").length;
      out.push(`@@ -${morceau[0][2] + 1},${ia} +${morceau[0][3] + 1},${ib} @@`);
      morceau.forEach((y) => out.push(y[0] + y[1]));
      k = fin;
    }
    return out;
  }
  KC.top = (x, o) => {
    if (!K.addons["metrics-server"]) return R.err("error: Metrics API not available", 1);
    if (H.now() - K.demarreA < 45000 || (K.metricsA && H.now() - K.metricsA < 45000)) return R.err("error: metrics not available yet", 1);
    if (o.ops[0] === "nodes" || o.ops[0] === "node" || o.ops[0] === "no") {
      const cpu = 900 + Math.floor(Math.random() * 400); const mem = 1850 + Math.floor(Math.random() * 200);
      return R.ok(T([["NAME", "CPU(cores)", "CPU(%)", "MEMORY(bytes)", "MEMORY(%)"], ["minikube", cpu + "m", Math.round(cpu / 120) + "%", mem + "Mi", Math.round(mem / 77.8) + "%"]]));
    }
    const pods = K.liste("Pod", nsDe(o), o.sel).filter((p) => p.demarre);
    if (!pods.length) return R.err(`No resources found in ${nsDe(o)} namespace.`, 0);
    return R.ok(T([["NAME", "CPU(cores)", "MEMORY(bytes)"]].concat(pods.map((p) => [p.metadata.name, Math.ceil(Math.random() * 3) + "m", (/postgres/.test(p.spec.containers[0].image) ? 38 : 4) + Math.floor(Math.random() * 6) + "Mi"]))));
  };
  KC["api-resources"] = () => R.ok(T([["NAME", "SHORTNAMES", "APIVERSION", "NAMESPACED", "KIND"]].concat(TYPES.map((t) => [t.res, t.noms[0] !== t.kind.toLowerCase() && t.noms[0] !== t.res ? t.noms[0] : "", t.api, String(!t.global), t.kind]))));
  KC.explain = (x, o) => R.ok([`(simulateur : « kubectl explain ${o.ops[0] || ""} » affiche la documentation des champs ; voir https://kubernetes.io/docs/reference/kubernetes-api/ .)`]);

  // Téléchargements de l'installation (tailles et barres de progression relevées en vrai).
  SIM.webExterne = Object.assign(SIM.webExterne || {}, {
    "dl.k8s.io/release/stable.txt": { contenu: "v1.37.1" },
    "dl.k8s.io/release/v1.37.1/bin/linux/amd64/kubectl": { taille: 61876408, duree: 900, progression: "100 59.01M 100 59.01M   0      0 117.3M      0                              0" },
    "github.com/kubernetes/minikube/releases/latest/download/minikube-linux-amd64": { taille: 142606336, duree: 2600, progression: "100 136.0M 100 136.0M   0      0 51.71M      0   00:02   00:02         58.31M" },
  });
  SIM.commandesExtra = SIM.commandesExtra || {};
  SIM.commandesExtra.kubectl = function (x) {
    const [sous, ...r] = x.args;
    if (!sous || sous === "--help" || sous === "-h") return R.ok(["kubectl controls the Kubernetes cluster manager.", "", " Find more information at: https://kubernetes.io/docs/reference/kubectl/", "", "Basic Commands:", "  create        Create a resource from a file or from stdin", "  expose        Take a replication controller, service, deployment or pod and expose it as a new Kubernetes service", "  run           Run a particular image on the cluster", "  set           Set specific features on objects", "  get           Display one or many resources", "  delete        Delete resources by file names, stdin, resources and names, or by resources and label selector", "", "Deploy Commands:", "  rollout       Manage the rollout of a resource", "  scale         Set a new size for a deployment, replica set, or replication controller", "", "Troubleshooting and Debugging Commands:", "  describe      Show details of a specific resource or group of resources", "  logs          Print the logs for a container in a pod", "  exec          Execute a command in a container", "  port-forward  Forward one or more local ports to a pod", "  top           Display resource (CPU/memory) usage", "", "Advanced Commands:", "  diff          Diff the live version against a would-be applied version", "  apply         Apply a configuration to a resource by file name or stdin", "", "Settings Commands:", "  config        Modify kubeconfig files", "  version       Print the client and server version information"]);
    const o = opts(r);
    if (sous === "version") return KC.version(x, o);
    if (sous === "config") return KC.config(x, o);
    if (!KC[sous]) return R.err([`error: unknown command "${sous}" for "kubectl"`], 1);
    if (o.dryRun === "client" && (sous === "create" || sous === "apply")) return KC[sous](x, o);
    if (K.etat !== "Running") return ERRCONN();
    K.avancer(H.now());
    return KC[sous](x, o);
  };

  /* -------------------------------------------------------- minikube */
  const ADDONS_IMG = ["    ▪ Using image docker.io/kubernetesui/metrics-scraper:v1.0.8", "    ▪ Using image gcr.io/k8s-minikube/storage-provisioner:v5", "    ▪ Using image docker.io/kubernetesui/dashboard:v2.7.0", "    ▪ Using image registry.k8s.io/metrics-server/metrics-server:v0.9.0"];
  SIM.commandesExtra.minikube = function (x) {
    const [sous, ...r] = x.args;
    const m = x.sh.ctx.hote.m;
    const l = [];
    switch (sous) {
      case "version": return R.ok(["minikube version: v1.39.0", "commit: 7a9f6a841470a207de8cf4bafcccee0969d8ba10"]);
      case "start": {
        const tourne = K.etat === "Running";
        l.push({ t: "😄  minikube v1.39.0 on Ubuntu 26.04 (kvm/amd64)" }, { t: "✨  Using the docker driver based on existing profile", d: 300 }, { t: "👍  Starting \"minikube\" primary control-plane node in \"minikube\" cluster", d: 200 }, { t: "🚜  Pulling base image v0.0.51 ...", d: 400 });
        if (tourne) { l.push({ t: "🏃  Updating the running docker \"minikube\" container ...", d: 300 }, { pause: 6000 }); H.avancer(6000); }
        else {
          l.push({ t: "🔄  Restarting existing docker container for \"minikube\" ...", d: 300 }, { pause: 14000 }); H.avancer(14000);
          const kic = K.kic; kic.etat = "exited"; m.demarrer(kic); kic.reseaux.minikube && (kic.reseaux.minikube.ip = IP_NOEUD);
          K.relancer();
        }
        l.push({ t: "📦  Preparing Kubernetes v1.37.0 on containerd 2.3.4 ..." }, { pause: tourne ? 4000 : 9000 }); H.avancer(tourne ? 4000 : 9000);
        l.push({ t: "🔎  Verifying Kubernetes components..." });
        const imgs = ADDONS_IMG.slice().sort(() => Math.random() - 0.5);
        imgs.forEach((t, k) => l.push({ t, d: k ? 120 : 600 }));
        l.push({ pause: 3500 }); H.avancer(3500);
        if (K.addons.dashboard) l.push({ t: "💡  Some dashboard features require the metrics-server addon. To enable all features please run:" }, { t: "" }, { t: "\tminikube addons enable metrics-server" }, { t: "" });
        l.push({ t: `🌟  Enabled addons: ${Object.keys(K.addons).filter((a) => K.addons[a]).sort(() => Math.random() - 0.5).join(", ")}`, d: 400 });
        l.push({ t: "🏄  Done! kubectl is now configured to use \"minikube\" cluster and \"default\" namespace by default", d: 300 });
        return { l, code: 0 };
      }
      case "stop": {
        l.push({ t: "✋  Stopping node \"minikube\"  ..." });
        if (K.etat === "Running") {
          l.push({ pause: 2500 }, { t: "🛑  Powering off \"minikube\" via SSH ..." }, { pause: 3500 }); H.avancer(6000);
          K.arreter(); const kic = K.kic; kic.arretDemande = true; kic.proc = kic.proc || {}; kic.proc.tFin = H.now(); m.fin(kic, 130);
        }
        l.push({ t: "🛑  1 node stopped." });
        return { l, code: 0 };
      }
      case "status": {
        if (K.etat === "Running") return R.ok(["minikube", "type: Control Plane", "host: Running", "kubelet: Running", "apiserver: Running", "kubeconfig: Configured", ""]);
        return R.ok(["minikube", "type: Control Plane", "host: Stopped", "kubelet: Stopped", "apiserver: Stopped", "kubeconfig: Stopped", ""], 7);
      }
      case "ip": return K.etat === "Running" ? R.ok(IP_NOEUD) : R.err(["", "❌  Exiting due to GUEST_STATUS: state: unknown state \"minikube\": host is not running"], 80);
      case "profile": {
        if (r[0] !== "list") return R.ok("minikube");
        const ok = K.etat === "Running" ? "OK     " : "Stopped";
        return R.ok(["┌──────────┬────────┬────────────┬──────────────┬─────────┬────────┬───────┬────────────────┬────────────────────┐", "│ PROFILE  │ DRIVER │  RUNTIME   │      IP      │ VERSION │ STATUS │ NODES │ ACTIVE PROFILE │ ACTIVE KUBECONTEXT │", "├──────────┼────────┼────────────┼──────────────┼─────────┼────────┼───────┼────────────────┼────────────────────┤",
          `│ minikube │ docker │ containerd │ 192.168.49.2 │ v1.37.0 │ ${ok.slice(0, 6)} │ 1     │ *              │ *                  │`, "└──────────┴────────┴────────────┴──────────────┴─────────┴────────┴───────┴────────────────┴────────────────────┘"]);
      }
      case "addons": {
        const [action, nom] = r;
        if (action === "list") return R.ok(["┌─────────────────────────────┬──────────┬────────────┬────────────────────────────────┐", "│         ADDON NAME          │ PROFILE  │   STATUS   │           MAINTAINER           │", "├─────────────────────────────┼──────────┼────────────┼────────────────────────────────┤"]
          .concat(["dashboard", "default-storageclass", "ingress", "metrics-server", "storage-provisioner"].map((a) => `│ ${O.pad(a, 27)} │ minikube │ ${K.addons[a] ? "enabled ✅" : "disabled  "} │ ${O.pad(a === "ingress" || a === "metrics-server" ? "Kubernetes" : "minikube", 30)} │`))
          .concat(["└─────────────────────────────┴──────────┴────────────┴────────────────────────────────┘"]));
        if (K.etat !== "Running") return R.err(["", `❌  Exiting due to MK_ADDON_ENABLE_PAUSED: enabled failed: check paused: list paused: crictl list: NewSession: new client: new client: dial tcp 127.0.0.1:32768: connect: connection refused`], 80);
        if (action === "enable" && nom === "metrics-server") { if (!K.addons[nom]) K.metricsA = H.now(); K.addons[nom] = true; return R.ok(["* metrics-server is an addon maintained by Kubernetes. For any concerns contact minikube on GitHub.", "You can view the list of minikube maintainers at: https://github.com/kubernetes/minikube/blob/master/OWNERS", "  - Using image registry.k8s.io/metrics-server/metrics-server:v0.9.0", "* The 'metrics-server' addon is enabled"]); }
        if (action === "enable" || action === "disable") { K.addons[nom] = action === "enable"; return R.ok(`* The '${nom}' addon is ${action === "enable" ? "enabled" : "disabled"}`); }
        return R.err("(simulateur : minikube addons list|enable|disable)", 1);
      }
      case "ssh": {
        if (K.etat !== "Running") return R.err(["", "❌  Exiting due to GUEST_STATUS: state: unknown state \"minikube\": host is not running"], 80);
        const i = r.indexOf("--"); const cmd = (i >= 0 ? r.slice(i + 1) : r).join(" ").replace(/^["']|["']$/g, "");
        if (/crictl version/.test(cmd)) return R.ok(["Version:  0.1.0", "RuntimeName:  containerd", "RuntimeVersion:  v2.3.4", "RuntimeApiVersion:  v1"]);
        if (/ctr namespace ls/.test(cmd)) return R.ok(["NAME   LABELS", "k8s.io", "moby"]);
        if (/crictl ps/.test(cmd)) return R.ok(T([["CONTAINER", "IMAGE", "CREATED", "STATE", "NAME", "ATTEMPT", "POD ID", "POD", "NAMESPACE"]].concat(K.objets.filter((p) => p.kind === "Pod" && (p.demarre || p.systeme)).map((p) => [O.hex(13), O.hex(13), "2 minutes ago", "Running", p.spec.containers[0].name, "0", O.hex(13), p.metadata.name, p.metadata.namespace]))));
        if (/uname -r/.test(cmd)) return R.ok(SIM.noyauVersion);
        if (/os-release/.test(cmd)) return R.ok(['PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"', 'NAME="Debian GNU/Linux"', 'VERSION_ID="12"']);
        if (!cmd) return R.err("(simulateur : pas de session interactive ; donne une commande après --, par exemple minikube ssh -- \"sudo crictl version\")", 1);
        return R.err(`bash: line 1: ${cmd.split(" ")[0]}: command not found`, 127);
      }
      case "service": return R.err("(simulateur : avec le pilote Docker, « minikube service --url » ouvre un tunnel et bloque le terminal. Utilise plutôt kubectl port-forward, ou curl http://$(minikube ip):<nodePort>.)", 1);
      case "dashboard": return R.err("(simulateur : le tableau de bord s'ouvre dans un navigateur ; non disponible ici.)", 1);
      case "delete": return R.err("(simulateur : « minikube delete » n'est pas simulé, pour garder le cluster des labs.)", 1);
      case undefined: case "--help": case "help": return R.ok(["minikube provisions and manages local Kubernetes clusters optimized for development workflows.", "", "Basic Commands:", "  start            Starts a local Kubernetes cluster", "  status           Gets the status of a local Kubernetes cluster", "  stop             Stops a running local Kubernetes cluster", "  dashboard        Access the Kubernetes dashboard running within the minikube cluster", "", "Configuration and Management Commands:", "  addons           Enable or disable a minikube addon", "  profile          Profile gets or sets the current minikube profile", "", "Networking and Connectivity Commands:", "  ip               Retrieves the IP address of the specified node", "  ssh              Log into the minikube environment (for debugging)", "", "Other Commands:", "  version          Print the version of minikube"]);
      default: return R.err(`Error: unknown command "${sous}" for "minikube"`, 1);
    }
  };
})(typeof window !== "undefined" ? window : globalThis);
