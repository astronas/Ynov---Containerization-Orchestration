/* Simulateur, images : docker build (BuildKit, cache, .dockerignore, secrets), image ls/rm/tag/inspect/history/save,
 * pull et push vers un registre local (registry:2). */
(function (G) {
  "use strict";
  const SIM = G.SIM; const O = SIM.outils; const R = SIM.R; const H = SIM.horloge; const chemin = SIM.chemin; const D = SIM.docker;
  const DOCKER = D.commandes; const Moteur = D.Moteur;

  /* ------------------------------------------------------------ outils */
  const repoDe = (ref) => ref.slice(0, ref.lastIndexOf(":"));
  const tagDe = (ref) => ref.slice(ref.lastIndexOf(":") + 1);
  const nomComplet = (ref) => { const r = repoDe(ref); return "docker.io/" + (r.includes("/") || /^[^/]+[.:]/.test(r) ? r : "library/" + r) + ":" + tagDe(ref); };
  D.repoDigests = (im) => [...new Set(im.tags.map(repoDe))].map((r) => `${r}@sha256:${im.id}`);
  // Taille d'une couche, comme une archive tar (blocs de 512 octets).
  function tailleCouche(fichiers) {
    let t = 1024;
    for (const [, n] of fichiers) { if (n.wh) { t += 512; continue; } t += 512 + (n.type === "d" ? 0 : Math.ceil((n.taille !== undefined ? n.taille : O.octets(n.contenu || "")) / 512) * 512); }
    return fichiers.size ? Math.ceil(t / 4096) * 4096 : 0;
  }
  function historiqueBase(im) {
    if (im.hist) return im.hist;
    const b = D.BASES[im.base];
    if (b && b.historique) return b.historique.slice().reverse().map(([c, s]) => ({ createdBy: c, taille: s, tronque: true }));
    const fam = { alpine: "alpine-minirootfs-3.22.2-x86_64.tar.gz", alpine324: "alpine-minirootfs-3.24.3-x86_64.tar.gz", busybox: "rootfs.tar.gz", debian: "rootfs.tar.xz", ubuntu: "ubuntu-noble-oci-amd64-root.tar.gz" }[im.famille] || "rootfs.tar";
    const h = [{ createdBy: `ADD ${fam} / # buildkit`, taille: O.tailleDocker(im.contenu * 0.6) }];
    for (let k = 1; k < (b ? b.couches : 1); k++) h.push({ createdBy: "RUN /bin/sh -c set -eux; … # buildkit", taille: O.tailleDocker(im.contenu * 0.4 / Math.max(1, b.couches - 1)) });
    (im.config.Env || []).slice(1).forEach((e) => h.push({ createdBy: `ENV ${e}`, taille: "0B" }));
    if (im.config.Entrypoint) h.push({ createdBy: `ENTRYPOINT ${JSON.stringify(im.config.Entrypoint).replace(/,/g, " ")}`, taille: "0B" });
    if (Object.keys(im.config.ExposedPorts || {}).length) h.push({ createdBy: `EXPOSE map[${Object.keys(im.config.ExposedPorts).map((p) => p + ":{}").join(" ")}]`, taille: "0B" });
    h.push({ createdBy: `CMD ${JSON.stringify(im.config.Cmd || []).replace(/,/g, " ")}`, taille: "0B" });
    return h;
  }

  /* ------------------------------------------------------- vues d'images */
  D.vueImage = (m, im) => ({
    Id: "sha256:" + im.id, RepoTags: im.tags.slice(), RepoDigests: D.repoDigests(im), Parent: "", Comment: im.base && !im.construite ? "" : "buildkit.dockerfile.v0",
    Created: O.date.iso(im.cree), DockerVersion: "", Author: "", Architecture: "amd64", Os: "linux", Size: im.disque,
    Config: { Env: im.config.Env, Cmd: im.config.Cmd, Entrypoint: im.config.Entrypoint, User: im.config.User || "", WorkingDir: im.config.WorkingDir || "", ExposedPorts: im.config.ExposedPorts, Labels: im.config.Labels, Volumes: im.config.Volumes, OnBuild: null, StopSignal: im.config.StopSignal, Healthcheck: im.config.Healthcheck || undefined },
    RootFS: { Type: "layers", Layers: im.couches.filter((c) => !c.vide).map((c, k) => "sha256:" + (c.id || D.hexDe(im.id + k))) },
    Metadata: { LastTagTime: O.date.iso(im.cree) },
  });
  const utilisee = (m, im) => m.conteneurs.some((c) => c.img === im);
  DOCKER.images = function (m, args) {
    const { o, ops } = SIM.options(args, ["f", "filter", "format"]);
    const filtres = [];
    args.forEach((a, k) => { if (a === "-f" || a === "--filter") filtres.push(args[k + 1]); else if (a.startsWith("--filter=")) filtres.push(a.slice(9)); });
    let refs = [...m.images.entries()];
    if (ops[0]) { const r = ops[0].includes(":") ? Moteur.ref(ops[0]) : null; refs = refs.filter(([ref]) => (r ? ref === r.ref : repoDe(ref) === Moteur.ref(ops[0]).repo)); }
    const refsF = filtres.filter((f) => f.startsWith("reference=")).map((f) => f.slice(10));
    if (refsF.length) refs = refs.filter(([ref]) => refsF.some((p) => { const motif = p.includes(":") ? p : p + ":*"; return new RegExp("^" + motif.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, "[^/]*") + "$").test(ref) || ref === Moteur.ref(p).ref; }));
    refs.sort(([a], [b]) => (a < b ? -1 : 1));
    if (o.q || o.quiet) return R.ok([...new Set(refs.map(([, im]) => im.id.slice(0, 12)))]);
    const vues = refs.map(([ref, im]) => ({ Repository: repoDe(ref), Tag: tagDe(ref), ID: im.id.slice(0, 12), CreatedSince: O.duree(H.now() - im.cree) + " ago", CreatedAt: O.date.iso(im.cree), Size: O.tailleDocker(im.disque), Digest: "sha256:" + im.id, Containers: String(m.conteneurs.filter((c) => c.img === im).length), ref, im }));
    if (o.format) return D.formater(o.format, vues, { ID: "IMAGE ID" });
    if (!vues.length) return R.ok(["IMAGE   ID             DISK USAGE   CONTENT SIZE   EXTRA"]);
    const larg = Math.max(5, ...vues.map((v) => v.ref.length)) + 3;
    return R.ok([O.pad("IMAGE", larg) + "ID             DISK USAGE   CONTENT SIZE   EXTRA"].concat(vues.map((v) => O.pad(v.ref, larg) + O.pad(v.ID, 15) + O.padG(O.tailleDocker(v.im.disque), 10) + "   " + O.padG(O.tailleDocker(v.im.contenu), 12) + "   " + O.pad(utilisee(m, v.im) ? "U" : "", 5))));
  };
  DOCKER.tag = function (m, args) {
    const [src, dst] = args.filter((a) => !a.startsWith("-"));
    if (!src || !dst) return R.err(["docker: 'docker tag' requires 2 arguments", "", "Usage:  docker tag SOURCE_IMAGE[:TAG] TARGET_IMAGE[:TAG]", "", "See 'docker tag --help' for more information"], 1);
    const im = m.image(src);
    if (!im) return R.err(`Error response from daemon: No such image: ${Moteur.ref(src).ref}`, 1);
    const r = Moteur.ref(dst);
    if (!/^[a-z0-9]/.test(r.repo) || /[A-Z]/.test(r.repo)) return R.err(`Error parsing reference: "${dst}" is not a valid repository/tag: invalid reference format: repository name (library/${r.repo}) must be lowercase`, 1);
    D.attacherTag(m, im, r.ref);
    return R.ok();
  };
  D.attacherTag = function (m, im, ref) {
    const ancien = m.images.get(ref);
    if (ancien && ancien !== im) { ancien.tags = ancien.tags.filter((t) => t !== ref); }
    m.images.set(ref, im);
    if (!im.tags.includes(ref)) im.tags.push(ref);
  };
  DOCKER.rmi = function (m, args) {
    const { o, ops } = SIM.options(args);
    const l = []; let code = 0;
    if (!ops.length) return R.err(["docker: 'docker image rm' requires at least 1 argument", "", "Usage:  docker image rm [OPTIONS] IMAGE [IMAGE...]", "", "See 'docker image rm --help' for more information"], 1);
    for (const n of ops) {
      const im = m.image(n);
      if (!im) { l.push({ t: `Error response from daemon: No such image: ${/^[0-9a-f]{6,}$/.test(n) ? n : Moteur.ref(n).ref}`, e: true }); code = 1; continue; }
      const parId = !m.images.has(Moteur.ref(n).ref);
      const refs = parId ? im.tags.slice() : [Moteur.ref(n).ref];
      if (parId && im.tags.length > 1 && !(o.f || o.force)) { l.push({ t: `Error response from daemon: conflict: unable to delete ${n} (must be forced) - image is referenced in multiple repositories`, e: true }); code = 1; continue; }
      const dernier = im.tags.filter((t) => !refs.includes(t)).length === 0;
      const util = m.conteneurs.find((c) => c.img === im);
      if (dernier && util && !(o.f || o.force)) {
        l.push({ t: util.etat === "running" ? `Error response from daemon: conflict: unable to delete ${im.id.slice(0, 12)} (cannot be forced) - image is being used by running container ${util.id}` : `Error response from daemon: conflict: unable to remove repository reference "${n}" (must force) - container ${util.id} is using its referenced image ${im.id.slice(0, 12)}`, e: true });
        code = 1; continue;
      }
      refs.forEach((ref) => { m.images.delete(ref); im.tags = im.tags.filter((t) => t !== ref); l.push({ t: `Untagged: ${ref}` }); });
      if (!im.tags.length) l.push({ t: `Deleted: sha256:${im.id}` });
    }
    return { l, code };
  };
  DOCKER.history = function (m, args) {
    const { o, ops } = SIM.options(args, ["format"]);
    const im = m.image(ops[0]);
    if (!im) return R.err(`Error response from daemon: No such image: ${Moteur.ref(ops[0] || "").ref}`, 1);
    const h = historiqueBase(im).slice().reverse();
    const tronq = (s) => (o["no-trunc"] ? s : O.ellipse(s, 45));
    const vues = h.map((x, k) => ({ ID: k === 0 ? im.id.slice(0, 12) : "<missing>", CreatedSince: O.duree(H.now() - (x.cree || im.cree)) + " ago", CreatedBy: tronq(x.createdBy), Size: x.taille, Comment: x.tronque || !im.construite ? "" : "buildkit.dockerfile.v0" }));
    if (o.q || o.quiet) return R.ok(vues.map((v) => v.ID));
    if (o.format) return D.formater(o.format, vues, { ID: "IMAGE" });
    return R.ok(O.tableau([["IMAGE", "CREATED", "CREATED BY", "SIZE", "COMMENT"]].concat(vues.map((v) => [v.ID, v.CreatedSince, v.CreatedBy, v.Size, v.Comment])), 3, 10));
  };
  DOCKER.pull = function (m, args) {
    const { ops } = SIM.options(args, ["platform"]);
    if (!ops[0]) return R.err(["docker: 'docker pull' requires 1 argument", "", "Usage:  docker pull [OPTIONS] NAME[:TAG|@DIGEST]", "", "See 'docker pull --help' for more information"], 1);
    const l = [];
    const im = m.tirer(ops[0], l, { explicite: true, force: true });
    return { l, code: im ? 0 : 1 };
  };
  DOCKER.save = function (m, args) {
    const { o, ops } = SIM.options(args, ["o", "output"]);
    const sortie = o.o || o.output;
    const ims = ops.map((n) => [n, m.image(n)]);
    const manque = ims.find(([, im]) => !im);
    if (manque) return R.err(`Error response from daemon: No such image: ${Moteur.ref(manque[0]).ref}`, 1);
    const entrees = { "blobs/": "", "blobs/sha256/": "", "oci-layout": '{"imageLayoutVersion":"1.0.0"}' };
    const manifestes = [];
    ims.forEach(([n, im]) => {
      const couches = [];
      im.couches.filter((c) => !c.vide).forEach((c, k) => {
        const dg = c.id || D.hexDe(im.id + "couche" + k);
        const e = {};
        for (const [p, nd] of c.fichiers) {
          if (nd.wh) { e[chemin.parent(p).slice(1) + (chemin.parent(p) === "/" ? "" : "/") + ".wh." + chemin.base(p)] = ""; continue; }
          e[p.slice(1) + (nd.type === "d" ? "/" : "")] = nd.type === "d" ? "" : (nd.contenu || "");
        }
        entrees["blobs/sha256/" + dg] = { entrees: e, taille: tailleCouche(c.fichiers) };
        couches.push(dg);
      });
      const conf = JSON.stringify({ architecture: "amd64", os: "linux", config: im.config, rootfs: { type: "layers", diff_ids: couches.map((x) => "sha256:" + x) } });
      const dConf = D.hexDe(conf); entrees["blobs/sha256/" + dConf] = conf;
      const man = JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", config: { digest: "sha256:" + dConf }, layers: couches.map((x) => ({ digest: "sha256:" + x })) });
      entrees["blobs/sha256/" + im.id] = man;
      manifestes.push({ Config: "blobs/sha256/" + dConf, RepoTags: [Moteur.ref(n).ref], Layers: couches.map((x) => "blobs/sha256/" + x) });
    });
    entrees["index.json"] = JSON.stringify({ schemaVersion: 2, manifests: ims.map(([n, im]) => ({ digest: "sha256:" + im.id, annotations: { "io.containerd.image.name": nomComplet(Moteur.ref(n).ref) } })) });
    entrees["manifest.json"] = JSON.stringify(manifestes);
    const taille = Object.values(entrees).reduce((s, v) => s + (typeof v === "string" ? O.octets(v) + 512 : v.taille + 512), 1024);
    if (!sortie) return R.err("cowardly refusing to save to a terminal. Use the -o flag or redirect", 1);
    const e = m.hote.fs.ecrire(chemin.norm(sortie, m.hote.sh.cwd), "", { archive: entrees, taille });
    if (e) return R.err(`failed to save image: open ${sortie}: ${SIM.MSG[e]}`, 1);
    return R.ok();
  };
  DOCKER.load = function (m, args) {
    const { o } = SIM.options(args, ["i", "input"]);
    const f = m.hote.fs.lire(chemin.norm(o.i || o.input || "", m.hote.sh.cwd));
    if (f.err || !f.node.archive) return R.err("Error response from daemon: unrecognized image format", 1);
    return R.ok(JSON.parse(f.node.archive["manifest.json"] || "[]").map((x) => `Loaded image: ${x.RepoTags[0]}`));
  };

  /* ------------------------------------------------------ registre local */
  function registreSur(m, hote) {
    const [h, port] = hote.split(":");
    return m.conteneurs.find((c) => c.etat === "running" && c.proc && c.proc.serveur === "registry" && c.ports.some((p) => String(p.hote) === port && (h === "localhost" || h === "127.0.0.1" || p.ip === h)));
  }
  DOCKER.push = function (m, args) {
    const { ops } = SIM.options(args);
    const nom = ops[0];
    if (!nom) return R.err(["docker: 'docker push' requires 1 argument", "", "Usage:  docker push [OPTIONS] NAME[:TAG]", "", "See 'docker push --help' for more information"], 1);
    const r = Moteur.ref(nom);
    const im = m.images.get(r.ref);
    if (!im) return R.err(`An image does not exist locally with the tag: ${r.repo}`, 1);
    const m2 = /^((?:localhost|127\.0\.0\.1|[\w.-]+\.\w+):?\d*)\/(.+)$/.exec(r.repo);
    const l = [{ t: `The push refers to repository [${r.repo.includes("/") ? r.repo : "docker.io/library/" + r.repo}]` }];
    if (!m2 || !/^(localhost|127\.0\.0\.1):\d+$/.test(m2[1])) {
      im.couches.filter((c) => !c.vide).slice(-3).forEach((c, k) => l.push({ t: `${D.hexDe(im.id + k, 12)}: Preparing` }));
      l.push({ t: "push access denied, repository does not exist or may require authorization: server message: insufficient_scope: authorization failed", e: true });
      return { l, code: 1 };
    }
    const reg = registreSur(m, m2[1]);
    const couches = im.couches.filter((c) => !c.vide).map((c, k) => c.id || D.hexDe(im.id + "couche" + k));
    const lignes = couches.concat([D.hexDe(im.id + "conf"), D.hexDe(im.id + "att"), D.hexDe(im.id + "man")]).map((x) => x.slice(0, 12));
    if (!reg) {
      l.push({ t: `${lignes[0]}: Preparing` });
      l.push({ t: `failed to do request: Head "http://${m2[1]}/v2/${m2[2]}/blobs/sha256:${couches[0]}": dial tcp 127.0.0.1:${m2[1].split(":")[1]}: connect: connection refused`, e: true });
      return { l, code: 1 };
    }
    reg.registre = reg.registre || { depots: {} };
    const depot = (reg.registre.depots[m2[2]] = reg.registre.depots[m2[2]] || {});
    reg.registre.blobs = reg.registre.blobs || new Set();
    reg.registre.images = reg.registre.images || {};
    const ordre = lignes.slice().sort(() => Math.random() - 0.5);
    const deja = ordre.every((x) => reg.registre.blobs.has(x));
    if (!deja) ordre.slice(0, 3).forEach((x) => l.push({ t: `${x}: Waiting` }));
    ordre.forEach((x, k) => l.push({ t: `${x}: ${reg.registre.blobs.has(x) ? (k % 4 === 3 ? "Already exists" : "Layer already exists") : "Pushed"}`, lent: !reg.registre.blobs.has(x) }));
    ordre.forEach((x) => reg.registre.blobs.add(x));
    depot[r.tag] = im.id; reg.registre.images[im.id] = im;
    l.push({ t: `${r.tag}: digest: sha256:${im.id} size: 856` });
    reg.logs.push({ t: `time="${O.date.iso(H.now())}" level=info msg="response completed" http.request.method=PUT http.request.uri="/v2/${m2[2]}/manifests/${r.tag}" http.response.status=201`, e: true, ts: H.now() });
    return { l, code: 0 };
  };
  Moteur.prototype.tirerRegistre = function (r, l, o) {
    const m2 = /^([^/]+)\/(.+)$/.exec(r.repo);
    const reg = registreSur(this, m2[1]);
    if (!reg) { l.push({ t: `Error response from daemon: Get "http://${m2[1]}/v2/": dial tcp 127.0.0.1:${m2[1].split(":")[1]}: connect: connection refused`, e: true }); return null; }
    const id = ((reg.registre || {}).depots || {})[m2[2]] && reg.registre.depots[m2[2]][r.tag];
    if (!id) { l.push({ t: `Error response from daemon: manifest for ${r.ref} not found: manifest unknown: manifest unknown`, e: true }); return null; }
    const im = reg.registre.images[id];
    const e = !o.explicite;
    if (e) l.push({ t: `Unable to find image '${r.ref}' locally`, e: true });
    l.push({ t: `${r.tag}: Pulling from ${m2[2]}`, e });
    l.push({ t: `Digest: sha256:${id}`, e }, { t: `Status: Downloaded newer image for ${r.ref}`, e });
    if (o.explicite) l.push({ t: r.ref });
    D.attacherTag(this, im, r.ref);
    return im;
  };

  /* --------------------------------------------------------- docker build */
  const INSTR = ["FROM", "RUN", "CMD", "LABEL", "MAINTAINER", "EXPOSE", "ENV", "ADD", "COPY", "ENTRYPOINT", "VOLUME", "USER", "WORKDIR", "ARG", "ONBUILD", "STOPSIGNAL", "HEALTHCHECK", "SHELL"];
  function lireDockerfile(texte) {
    const lignes = texte.split("\n"); const out = [];
    let cur = ""; let debut = 0;
    for (let k = 0; k < lignes.length; k++) {
      let l = lignes[k];
      if (!cur && /^\s*#/.test(l)) continue;
      if (!cur && !l.trim()) continue;
      if (!cur) debut = k + 1;
      if (/\\\s*$/.test(l)) { cur += l.replace(/\\\s*$/, " "); continue; }
      cur += l;
      const m = /^\s*(\S+)\s*(.*)$/.exec(cur);
      cur = "";
      if (!m) continue;
      const cmd = m[1].toUpperCase();
      if (!INSTR.includes(cmd)) return { erreur: `dockerfile parse error on line ${debut}: unknown instruction: ${m[1]}`, ligne: debut };
      out.push({ cmd, brut: m[2].trim(), ligne: debut, texte: `${m[1]} ${m[2].trim()}`.trim() });
    }
    if (!out.length) return { erreur: "the Dockerfile cannot be empty" };
    return { instr: out };
  }
  const jsonOuShell = (s) => { const t = s.trim(); if (t.startsWith("[")) { try { return { exec: JSON.parse(t) }; } catch (e) { /* forme shell */ } } return { shell: t }; };
  // Motifs .dockerignore : * ne traverse pas les dossiers, ** si.
  function motifIgnore(p) {
    const neg = p.startsWith("!"); if (neg) p = p.slice(1);
    p = p.replace(/^\.\//, "").replace(/^\//, "").replace(/\/$/, "");
    let re = ""; for (let k = 0; k < p.length; k++) {
      const c = p[k];
      if (c === "*" && p[k + 1] === "*") { re += ".*"; k++; if (p[k + 1] === "/") { re = re.slice(0, -2) + "(?:.*/)?"; k++; } continue; }
      if (c === "*") { re += "[^/]*"; continue; }
      if (c === "?") { re += "[^/]"; continue; }
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    return { neg, re: new RegExp("^" + re + "(?:/.*)?$") };
  }
  function contexteBuild(fs, dossier) {
    const ign = fs.lire(dossier + "/.dockerignore");
    const motifs = ign.err ? [] : ign.contenu.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map(motifIgnore);
    const exclu = (rel) => { let ex = false; motifs.forEach((m) => { if (m.re.test(rel)) ex = !m.neg; }); return ex; };
    const fichiers = fs.parcourir(dossier).filter((e) => e.p !== dossier).map((e) => ({ rel: e.p.slice(dossier.length + 1), node: e.node })).filter((e) => !exclu(e.rel));
    const taille = fichiers.filter((e) => e.node.type === "f").reduce((s, e) => s + fs.taille(e.node) + 35, 0) + 17;
    return { fichiers, taille, ignore: ign.err ? null : O.octets(ign.contenu) };
  }
  const t0s = (ms) => (ms / 1000).toFixed(1) + "s";

  DOCKER.buildx = (m, args, x) => (args[0] === "build" ? DOCKER.build(m, args.slice(1), x) : R.err("(simulateur : seul « docker buildx build » est simulé.)", 1));
  DOCKER.builder = (m, args, x) => (args[0] === "build" ? DOCKER.build(m, args.slice(1), x) : R.err("(simulateur : non simulé.)", 1));
  DOCKER.build = function (m, args, x) {
    const { o, ops } = SIM.options(args, ["t", "tag", "f", "file", "progress", "secret", "build-arg", "target", "platform", "o", "output", "cache-from", "label"]);
    const tags = []; const secrets = {}; const argsBuild = {};
    for (let k = 0; k < args.length; k++) {
      const a = args[k]; const v = (pre) => (a.startsWith(pre + "=") ? a.slice(pre.length + 1) : args[k + 1]);
      if (a === "-t" || a === "--tag" || a.startsWith("--tag=")) tags.push(v("--tag"));
      if (a === "--secret" || a.startsWith("--secret=")) { const kv = Object.fromEntries(v("--secret").split(",").map((p) => p.split("="))); secrets[kv.id] = kv.src || kv.source; }
      if (a === "--build-arg" || a.startsWith("--build-arg=")) { const s = v("--build-arg"); const i = s.indexOf("="); argsBuild[s.slice(0, i)] = s.slice(i + 1); }
    }
    const silence = !!(o.q || o.quiet);
    const ctxArg = ops[0];
    if (!ctxArg) return R.err(["ERROR: docker buildx build requires 1 argument", "", "Usage:  docker buildx build [OPTIONS] PATH | URL | -", "", "Start a build"], 1);
    const fs = m.hote.fs; const cwd = m.hote.sh.cwd;
    const dossier = chemin.norm(ctxArg, cwd);
    const l = []; const P = (t) => { if (!silence) l.push({ t, e: true }); };
    const echec = (msg) => { l.push({ t: `ERROR: failed to build: failed to solve: ${msg}`, e: true }); return { l, code: 1 }; };
    if (!fs.stat(dossier)) return echec(`unable to prepare context: path "${ctxArg}" not found`) && { l: [{ t: `ERROR: failed to build: unable to prepare context: path "${ctxArg}" not found`, e: true }], code: 1 };
    const fDock = o.f || o.file ? chemin.norm(o.f || o.file, cwd) : dossier + "/Dockerfile";
    const nomDock = o.f || o.file || "Dockerfile";
    let n = 0; const etape = () => ++n;
    P(`#0 building with "default" instance using docker driver`); P("");
    const df = fs.lire(fDock);
    const n1 = etape();
    P(`#${n1} [internal] load build definition from ${chemin.base(nomDock)}`);
    if (df.err) { P(`#${n1} transferring dockerfile: 2B done`); P(`#${n1} DONE 0.0s`); return echec(`failed to read dockerfile: open ${chemin.base(nomDock)}: no such file or directory`); }
    P(`#${n1} transferring dockerfile: ${O.octets(df.contenu)}B done`); P(`#${n1} DONE 0.0s`); P("");
    const lu = lireDockerfile(df.contenu);
    if (lu.erreur) return echec(lu.erreur);
    // Étapes (stages) et variables ARG globales.
    const stades = []; const argsGlob = Object.assign({}, argsBuild);
    let cur = null;
    for (const ins of lu.instr) {
      if (ins.cmd === "FROM") { const mm = /^(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?$/i.exec(ins.brut); cur = { base: mm[1].replace(/\$\{?(\w+)\}?/g, (_, k) => argsGlob[k] || ""), nom: mm[2] || null, instr: [], from: ins }; stades.push(cur); continue; }
      if (!cur) { if (ins.cmd === "ARG") { const [k, v] = ins.brut.split("="); if (argsGlob[k] === undefined) argsGlob[k] = v; continue; } return echec(`dockerfile parse error on line ${ins.ligne}: no build stage in current context`); }
      cur.instr.push(ins);
    }
    if (!stades.length) return echec("no build stage in current context");
    // Métadonnées des images de base.
    const bases = [...new Set(stades.map((s) => s.base).filter((b) => !stades.some((s) => s.nom === b) && b !== "scratch"))];
    const imgBase = {};
    for (const b of bases) {
      const k = etape(); P(`#${k} [internal] load metadata for ${nomComplet(Moteur.ref(b).ref)}`);
      let im = m.image(b); let tire = false;
      if (!im) { const tmp = []; im = m.tirer(b, tmp, { explicite: true }); tire = true; if (!im) { P(`#${k} ERROR: docker.io/${b}: not found`); return echec(`${nomComplet(Moteur.ref(b).ref)}: failed to resolve source metadata for ${nomComplet(Moteur.ref(b).ref)}: pull access denied, repository does not exist or may require authorization: server message: insufficient_scope: authorization failed`); } }
      imgBase[b] = { im, tire };
      P(`#${k} DONE ${tire ? "0.8s" : "0.0s"}`); P("");
    }
    const ctx = contexteBuild(fs, dossier);
    const kIgn = etape(); P(`#${kIgn} [internal] load .dockerignore`); P(`#${kIgn} transferring context: ${ctx.ignore === null ? 2 : ctx.ignore + 40}B done`); P(`#${kIgn} DONE 0.0s`); P("");
    const besoinCtx = stades.some((s) => s.instr.some((i) => (i.cmd === "COPY" || i.cmd === "ADD") && !/--from=/.test(i.brut)));
    const gros = ctx.taille > 5e6;
    if (besoinCtx) { const k = etape(); P(`#${k} [internal] load build context`); P(`#${k} transferring context: ${O.tailleDocker(ctx.taille, 4)} ${gros ? t0s(ctx.taille / 130e6) + " " : ""}done`); P(`#${k} DONE ${gros ? t0s(ctx.taille / 130e6) : "0.0s"}`); P(""); if (gros) l.push({ pause: Math.round(ctx.taille / 130e3) }); }
    // Construction de chaque stade.
    const resultats = {};
    let cle = "";
    const cible = o.target ? stades.findIndex((s) => s.nom === o.target) : stades.length - 1;
    const etapesFs = (s) => s.instr.filter((i) => ["RUN", "COPY", "ADD", "WORKDIR"].includes(i.cmd)).length + 1;
    for (let si = 0; si <= cible; si++) {
      const st = stades[si];
      const parent = resultats[st.base] || null;
      const base = parent || (imgBase[st.base] ? imgBase[st.base].im : null);
      const total = etapesFs(st); let num = 1;
      const pref = stades.length > 1 ? (st.nom || "stage-" + si) + " " : "";
      const kFrom = etape();
      const digestBase = base ? base.id : "";
      P(`#${kFrom} [${pref}${num}/${total}] FROM ${parent ? st.base : nomComplet(Moteur.ref(st.base).ref)}${parent ? "" : "@sha256:" + digestBase}`);
      if (!parent) P(`#${kFrom} resolve ${nomComplet(Moteur.ref(st.base).ref)}@sha256:${digestBase} 0.0s done`);
      if (!parent && imgBase[st.base].tire) { P(`#${kFrom} sha256:${D.hexDe(st.base + "c", 64)} ${O.tailleDocker(base.contenu, 3)} / ${O.tailleDocker(base.contenu, 3)} 0.6s done`); P(`#${kFrom} extracting sha256:${D.hexDe(st.base + "c", 64)} 0.3s done`); l.push({ pause: 900 }); }
      P(`#${kFrom} DONE ${!parent && imgBase[st.base].tire ? "1.0s" : "0.0s"}`); P("");
      const etat = { couches: base.couches.slice(), config: JSON.parse(JSON.stringify(base.config)), hist: historiqueBase(base).slice(), famille: base.famille, variante: base.variante, programme: base.programme, base: base.base };
      etat.config.Labels = etat.config.Labels || {};
      const args2 = Object.assign({}, argsGlob);
      cle = "base:" + base.id;
      const env = () => { const e = {}; etat.config.Env.forEach((v) => { const k = v.indexOf("="); e[v.slice(0, k)] = v.slice(k + 1); }); return Object.assign({}, args2, e); };
      const subst = (s) => s.replace(/\$\{(\w+)(?::-([^}]*))?\}|\$(\w+)/g, (_, a, def, b) => { const v = env()[a || b]; return v !== undefined && v !== "" ? v : def || ""; });
      for (const ins of st.instr) {
        const brut = subst(ins.brut);
        if (["ENV", "USER", "EXPOSE", "CMD", "ENTRYPOINT", "LABEL", "ARG", "VOLUME", "STOPSIGNAL", "HEALTHCHECK", "SHELL", "MAINTAINER", "ONBUILD"].includes(ins.cmd)) {
          cle = D.hexDe(cle + "\n" + ins.texte);
          let cb = `${ins.cmd} ${brut}`;
          if (ins.cmd === "ENV") { const paires = /^\w+\s+[^=]*$/.test(brut) ? [[brut.split(/\s+/)[0], brut.split(/\s+/).slice(1).join(" ")]] : (brut.match(/(\w+)=("[^"]*"|\S+)/g) || []).map((p) => { const i = p.indexOf("="); return [p.slice(0, i), p.slice(i + 1).replace(/^"|"$/g, "")]; }); paires.forEach(([k, v]) => { etat.config.Env = etat.config.Env.filter((e) => !e.startsWith(k + "=")).concat(`${k}=${v}`); }); cb = "ENV " + paires.map(([k, v]) => `${k}=${v}`).join(" "); }
          if (ins.cmd === "USER") etat.config.User = brut;
          if (ins.cmd === "EXPOSE") { brut.split(/\s+/).forEach((p) => { etat.config.ExposedPorts = Object.assign({}, etat.config.ExposedPorts, { [p.includes("/") ? p : p + "/tcp"]: {} }); }); cb = `EXPOSE map[${brut.split(/\s+/).map((p) => (p.includes("/") ? p : p + "/tcp") + ":{}").join(" ")}]`; }
          if (ins.cmd === "CMD" || ins.cmd === "ENTRYPOINT") { const v = jsonOuShell(brut); const val = v.exec || ["/bin/sh", "-c", v.shell]; if (ins.cmd === "CMD") etat.config.Cmd = val; else { etat.config.Entrypoint = val; etat.config.Cmd = null; } cb = `${ins.cmd} [${val.map((s) => JSON.stringify(s)).join(" ")}]`; }
          if (ins.cmd === "LABEL") (brut.match(/(\S+)=("[^"]*"|\S+)/g) || []).forEach((p) => { const i = p.indexOf("="); etat.config.Labels[p.slice(0, i)] = p.slice(i + 1).replace(/^"|"$/g, ""); });
          if (ins.cmd === "ARG") { const [k, v] = brut.split("="); if (args2[k] === undefined) args2[k] = v || ""; if (argsBuild[k] !== undefined) args2[k] = argsBuild[k]; cb = `ARG ${k}${args2[k] ? "=" + args2[k] : ""}`; }
          if (ins.cmd === "VOLUME") { const v = jsonOuShell(brut); (v.exec || v.shell.split(/\s+/)).forEach((p) => { etat.config.Volumes = Object.assign({}, etat.config.Volumes, { [p]: {} }); }); cb = `VOLUME [${(v.exec || v.shell.split(/\s+/)).join(" ")}]`; }
          if (ins.cmd === "HEALTHCHECK") {
            const mm = /^((?:--\S+\s+)*)CMD\s+(.*)$/i.exec(brut);
            if (/^NONE$/i.test(brut)) etat.config.Healthcheck = { Test: ["NONE"] };
            else if (mm) { const op = Object.fromEntries((mm[1].match(/--(\S+?)=(\S+)/g) || []).map((p) => p.slice(2).split("="))); const v = jsonOuShell(mm[2]); etat.config.Healthcheck = { Test: v.exec ? ["CMD"].concat(v.exec) : ["CMD-SHELL", v.shell], Interval: D.dureeMs(op.interval || "30s"), Timeout: D.dureeMs(op.timeout || "30s"), Retries: parseInt(op.retries || "3", 10), StartPeriod: D.dureeMs(op["start-period"] || "0s") }; }
          }
          if (ins.cmd === "STOPSIGNAL") etat.config.StopSignal = brut;
          etat.hist.push({ createdBy: cb, taille: "0B", cree: H.now() });
          continue;
        }
        // Étapes qui touchent au système de fichiers.
        num++;
        const k = etape();
        P(`#${k} [${pref}${num}/${total}] ${ins.cmd} ${ins.brut}`);
        const upper = new Map();
        const montages = [];
        let cleIns = cle + "\n" + ins.cmd + " " + brut + "\nUSER=" + etat.config.User + "\nWD=" + etat.config.WorkingDir;
        let copie = null;
        if (ins.cmd === "COPY" || ins.cmd === "ADD") {
          const toks = brut.match(/"[^"]*"|\S+/g).map((t) => t.replace(/^"|"$/g, ""));
          const flags = {}; while (toks[0] && toks[0].startsWith("--")) { const [kk, vv] = toks.shift().slice(2).split("="); flags[kk] = vv; }
          if (toks[0] && toks[0].startsWith("[")) { /* forme JSON */ }
          const dest = toks.pop(); const srcs = toks;
          const deStade = flags.from ? resultats[flags.from] || resultats[stades[parseInt(flags.from, 10)] && stades[parseInt(flags.from, 10)].nom] : null;
          if (flags.from && !deStade) { const imx = m.image(flags.from); if (!imx) { P(`#${k} ERROR: ${flags.from}: not found`); return echec(`failed to resolve source metadata for ${flags.from}`); } }
          const items = [];
          for (const s of srcs) {
            const srel = s.replace(/^\.\//, "").replace(/\/$/, "").replace(/^\/+/, "");
            if (deStade) {
              const fsS = new D.FSConteneur({ couches: deStade.couches.map((c) => c.fichiers) });
              const p0 = chemin.norm(s, deStade.config.WorkingDir || "/");
              const ent = fsS.parcourir(p0);
              if (!ent.length) { P(`#${k} ERROR: failed to calculate checksum of ref ${O.hex(25)}::${O.hex(25)}: "${p0}": not found`); return echec(`failed to compute cache key: failed to calculate checksum of ref ${O.hex(25)}::${O.hex(25)}: "${p0}": not found`); }
              items.push({ s, rel: p0, entrees: ent.map((e) => ({ rel: e.p.slice(p0.length).replace(/^\//, ""), node: e.node })), dossier: ent[0].node.type === "d" });
              continue;
            }
            const re = new RegExp("^" + (srel === "." || srel === "" ? ".*" : srel.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")) + "$");
            const exact = ctx.fichiers.filter((e) => srel === "." || srel === "" ? true : re.test(e.rel));
            const racine = exact.find((e) => e.rel === srel);
            const sous = srel === "." || srel === "" ? ctx.fichiers : ctx.fichiers.filter((e) => e.rel.startsWith(srel + "/"));
            if (!exact.length && !sous.length) {
              P(`#${k} ERROR: failed to calculate checksum of ref ${O.hex(25)}::${O.hex(25)}: "/${srel}": not found`); P("");
              l.push({ t: "------", e: true }, { t: ` > [${pref}${num}/${total}] ${ins.cmd} ${ins.brut}:`, e: true }, { t: "------", e: true }, { t: `${chemin.base(nomDock)}:${ins.ligne}`, e: true }, { t: "--------------------", e: true }, { t: `${O.padG(ins.ligne, 3)} | >>> ${ins.texte}`, e: true }, { t: "--------------------", e: true });
              return echec(`failed to compute cache key: failed to calculate checksum of ref ${O.hex(25)}::${O.hex(25)}: "/${srel}": not found`);
            }
            if (racine && racine.node.type === "d" || srel === "." || srel === "") items.push({ s, rel: srel, entrees: sous.map((e) => ({ rel: e.rel.slice(srel === "." || srel === "" ? 0 : srel.length + 1), node: e.node })), dossier: true });
            else exact.filter((e) => e.node.type === "f").forEach((e) => items.push({ s, rel: e.rel, entrees: [{ rel: "", node: e.node }], dossier: false }));
          }
          copie = { items, dest, flags };
          cleIns += "\n" + items.map((it) => it.rel + ":" + it.entrees.map((e) => e.rel + "=" + (e.node.contenu || "") + (e.node.taille || "")).join("|")).join(";");
        }
        const cleN = D.hexDe(cleIns);
        const cache = !(o["no-cache"]) && m.cacheBuild.get(cleN);
        if (cache) {
          P(`#${k} CACHED`); P("");
          etat.couches.push(cache.couche); etat.hist.push(cache.hist);
          if (ins.cmd === "WORKDIR") etat.config.WorkingDir = chemin.norm(brut, etat.config.WorkingDir || "/");
          cle = cleN; continue;
        }
        const t0 = H.now();
        const fsT = new D.FSConteneur({ couches: etat.couches.map((c) => c.fichiers), upper, montages });
        const lookup = (spec) => { const [u, g] = String(spec).split(":"); const p = (fsT.lire("/etc/passwd").contenu || "").split("\n").map((v) => v.split(":")); const gr = (fsT.lire("/etc/group").contenu || "").split("\n").map((v) => v.split(":")); const ue = p.find((v) => v[0] === u || v[2] === u); const ge = gr.find((v) => v[0] === (g || u) || v[2] === (g || u)); return { uid: ue ? +ue[2] : /^\d+$/.test(u) ? +u : 0, gid: ge ? +ge[2] : ue ? +ue[3] : /^\d+$/.test(g || u) ? +(g || u) : 0, ok: !!ue || /^\d+$/.test(u) }; };
        let cb = "";
        if (ins.cmd === "WORKDIR") {
          const wd = chemin.norm(brut, etat.config.WorkingDir || "/");
          fsT.mkdir(wd, { parents: true, uid: 0, gid: 0 });
          etat.config.WorkingDir = wd; cb = `WORKDIR ${wd}`;
        } else if (ins.cmd === "RUN") {
          let cmdTxt = brut; const mounts = [];
          while (/^--\S+/.test(cmdTxt)) { const mm = /^--(\S+)\s*/.exec(cmdTxt); mounts.push(mm[1]); cmdTxt = cmdTxt.slice(mm[0].length); }
          mounts.filter((v) => v.startsWith("mount=")).forEach((v) => {
            const kv = Object.fromEntries(v.slice(6).split(",").map((p) => p.split("=")));
            if (kv.type === "secret") {
              const src = secrets[kv.id];
              const dst = kv.target || kv.dst || "/run/secrets/" + kv.id;
              if (src) { const p = chemin.norm(src, cwd); if (fs.stat(p)) montages.push({ dest: dst, fs, src: p, ro: true, type: "bind" }); }
            }
          });
          fsT.montages = montages.slice().sort((a, b) => b.dest.length - a.dest.length);
          const v = jsonOuShell(cmdTxt);
          const uid = lookup(etat.config.User || "0").uid;
          fsT.uid = uid;
          const pseudo = { config: { Hostname: "buildkitsandbox", User: etat.config.User }, montages: fsT.montages, hostConfig: { CapAdd: null, CapDrop: null, Privileged: false, Memory: 0, SecurityOpt: null }, reseaux: {}, img: { famille: etat.famille, variante: etat.variante, base: etat.base }, envMap: env(), etat: "running", ports: [], extra: [] };
          const sh = new SIM.Shell({ fs: fsT, cwd: etat.config.WorkingDir || "/", env: Object.assign({ HOME: uid ? "/home" : "/root", HOSTNAME: "buildkitsandbox" }, env()), variante: etat.variante === "dash" ? "dash" : "sh", commandes: D.commandesConteneur, ctx: { conteneur: pseudo, moteur: m, user: etat.config.User }, uid });
          const r = v.exec ? sh.lancer(v.exec, null) : sh.executer(v.shell);
          let tps = 0.05 + Math.random() * 0.1;
          r.l.filter((y) => y.t !== undefined).forEach((y) => { tps += 0.01; P(`#${k} ${tps.toFixed(3)} ${y.t}`); });
          cb = `RUN /bin/sh -c ${v.exec ? v.exec.join(" ") : v.shell} # buildkit`;
          if (r.code !== 0) {
            const proc = v.exec ? JSON.stringify(v.exec).replace(/,/g, " ") : `/bin/sh -c ${v.shell}`;
            P(`#${k} ERROR: process "${proc}" did not complete successfully: exit code: ${r.code}`);
            l.push({ t: "------", e: true }, { t: ` > [${pref}${num}/${total}] RUN ${ins.brut}:`, e: true });
            r.l.filter((y) => y.t !== undefined).forEach((y) => l.push({ t: `${(0.1).toFixed(3)} ${y.t}`, e: true }));
            l.push({ t: "------", e: true }, { t: `${chemin.base(nomDock)}:${ins.ligne}`, e: true }, { t: "--------------------", e: true }, { t: `${O.padG(ins.ligne, 3)} | >>> ${ins.texte}`, e: true }, { t: "--------------------", e: true });
            return echec(`process "${proc}" did not complete successfully: exit code: ${r.code}`);
          }
          l.push({ pause: 300 });
        } else if (copie) {
          const wd = etat.config.WorkingDir || "/";
          let destAbs = chemin.norm(copie.dest, wd);
          const versDossier = copie.dest.endsWith("/") || copie.dest === "." || copie.items.length > 1 || copie.items.some((it) => it.dossier);
          const own = copie.flags.chown ? lookup(copie.flags.chown) : { uid: 0, gid: 0 };
          if (copie.flags.chown && !own.ok) { P(`#${k} ERROR: failed to parse user: unable to find user ${copie.flags.chown.split(":")[0]}: no matching entries in passwd file`); return echec(`failed to compute cache key: unable to convert uid/gid chown string to host mapping: can't find uid for user ${copie.flags.chown.split(":")[0]}: no such user: ${copie.flags.chown.split(":")[0]}`); }
          if (versDossier) fsT.mkdir(destAbs, { parents: true, uid: 0, gid: 0 });
          else fsT.mkdir(chemin.parent(destAbs), { parents: true, uid: 0, gid: 0 });
          for (const it of copie.items) {
            for (const e of it.entrees) {
              let cibleP;
              if (it.dossier) cibleP = e.rel ? destAbs + "/" + e.rel : destAbs;
              else cibleP = versDossier || (fsT.stat(destAbs) && fsT.stat(destAbs).type === "d") ? destAbs + "/" + chemin.base(it.rel) : destAbs;
              cibleP = chemin.norm(cibleP, "/");
              if (e.node.type === "d") { if (cibleP !== destAbs) fsT.mkdir(cibleP, { parents: true, uid: own.uid, gid: own.gid }); continue; }
              fsT.mkdir(chemin.parent(cibleP), { parents: true, uid: 0, gid: 0 });
              upper.set(cibleP, { type: "f", contenu: e.node.contenu, taille: e.node.taille, uid: own.uid, gid: own.gid, mode: copie.flags.chmod ? parseInt(copie.flags.chmod, 8) : e.node.mode || 0o644, mtime: e.node.mtime });
            }
          }
          cb = `${ins.cmd} ${brut} # buildkit`;
          if (gros && copie.items.some((it) => it.entrees.some((e) => (e.node.taille || 0) > 1e6))) l.push({ pause: 600 });
        }
        const couche = { fichiers: upper, vide: upper.size === 0 && ins.cmd === "WORKDIR", id: D.hexDe(cleN + "couche") };
        couche.taille = tailleCouche(upper);
        const hist = { createdBy: cb, taille: O.tailleDocker(couche.taille), cree: H.now() };
        etat.couches.push(couche); etat.hist.push(hist);
        m.cacheBuild.set(cleN, { couche, hist });
        const duree = Math.max(H.now() - t0, ins.cmd === "RUN" ? 300 + Math.random() * 200 : 40);
        P(`#${k} DONE ${t0s(duree)}`); P("");
        cle = cleN;
      }
      resultats[st.nom || String(si)] = { couches: etat.couches, config: etat.config, hist: etat.hist, famille: etat.famille, variante: etat.variante };
      if (si === cible) {
        // Exportation.
        const k = etape();
        const id = D.hexDe(cle + JSON.stringify(etat.config));
        const deja = [...m.images.values()].find((im) => im.id === id);
        P(`#${k} exporting to image`);
        P(`#${k} exporting layers ${deja ? "" : "0.1s "}done`.replace("  ", " "));
        P(`#${k} exporting manifest sha256:${D.hexDe(id + "m")} done`);
        P(`#${k} exporting config sha256:${D.hexDe(id + "c")} done`);
        P(`#${k} exporting attestation manifest sha256:${D.hexDe(id + "a")} 0.0s done`);
        P(`#${k} exporting manifest list sha256:${id} 0.0s done`);
        if (tags.length) { P(`#${k} naming to ${tags.map((t) => nomComplet(Moteur.ref(t).ref)).join(", ")} done`); P(`#${k} unpacking to ${tags.map((t) => nomComplet(Moteur.ref(t).ref)).join(", ")} 0.1s done`); }
        P(`#${k} DONE 0.2s`);
        const ajoutes = etat.couches.slice(base.couches.length);
        const im = deja || {
          id, tags: [], digest: id, base: etat.base, famille: etat.famille, variante: etat.variante, programme: etat.programme, construite: true,
          couches: etat.couches, cree: H.now(), config: etat.config, hist: etat.hist, stop: base.stop,
          disque: base.disque + ajoutes.reduce((s, c) => s + (c.taille || 0), 0) - 0.5e6, contenu: base.contenu + ajoutes.reduce((s, c) => s + (c.taille || 0), 0) / 2.6 - 0.6e6,
        };
        if (!tags.length && !deja) m.images.set("<none>:" + id.slice(0, 12), im);
        tags.forEach((t) => D.attacherTag(m, im, Moteur.ref(t).ref));
        if (silence) l.push({ t: `sha256:${id}` });
      }
    }
    return { l, code: 0 };
  };

  // Alias : docker image <action>.
  DOCKER.image = function (m, args, x) {
    const [action, ...r] = args;
    const f = { ls: "images", list: "images", rm: "rmi", remove: "rmi", tag: "tag", inspect: "inspect", history: "history", pull: "pull", push: "push", save: "save", load: "load", build: "build" }[action];
    if (action === "inspect") return DOCKER.inspect(m, ["--type", "image"].concat(r), x);
    if (action === "prune") return R.err("(simulateur : « docker image prune » n'est pas simulé : supprime les images une par une avec docker image rm.)", 1);
    if (!f) return R.err(`docker: unknown command: docker image ${action || ""}`, 1);
    return DOCKER[f](m, r, x);
  };
})(typeof window !== "undefined" ? window : globalThis);
