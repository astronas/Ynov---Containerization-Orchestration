/* Terminal simulé dans le navigateur, sans serveur.
 * Le moteur (shell, Docker, Compose, Kubernetes) est dans sim-*.js ; ce fichier gère l'affichage :
 * terminal, page de lab (terminal à gauche, tutoriel à droite) et Conti, le robot guide.
 * Composants : <div class="terminal-sim"></div> et <div class="lab-page" data-lab="nom"></div>
 * Le lab guidé est lu dans assets/labs/<nom>.json. */
(function () {
  "use strict";
  const SIM = window.SIM;

  /* ------------------------------------------------------- le composant */
  const scriptCourant = document.currentScript && document.currentScript.src;
  const attendre = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const entre = (a, b) => a + Math.random() * (b - a);
  // Une pause virtuelle (sleep 25, arrêt de 10 s, attente d'un healthcheck) est raccourcie à l'écran.
  const pauseReelle = (ms) => (ms <= 1500 ? ms : 1500 + Math.min((ms - 1500) * 0.15, 4500));

  function creer(el) {
    if (el.dataset.pret) return;
    el.dataset.pret = "1";
    const hote = new SIM.Hote();
    el.hote = hote;
    const historique = []; let posHist = 0;
    let lab = null; let etape = 0; let mode = "libre"; let preparation = [];
    let tampon = null; // lignes déjà saisies d'une commande multi-lignes (heredoc, guillemet ouvert)

    el.innerHTML = `
      <div class="ts-barre"><span class="ts-points"><i></i><i></i><i></i></span>
        <span class="ts-titre">eleve@lab: ~ · simulateur Docker</span>
        <span class="ts-modes" role="tablist">
          <button type="button" class="ts-mode" data-mode="guide" role="tab">Guidé</button>
          <button type="button" class="ts-mode" data-mode="libre" role="tab">Libre</button>
        </span>
        <button type="button" class="ts-reset" title="Remettre la machine à zéro">↺</button>
      </div>
      <div class="ts-etape" hidden></div>
      <div class="ts-ecran" aria-live="polite"></div>
      <label class="ts-ligne"><span class="ts-invite">eleve@lab:~$</span>
        <textarea class="ts-saisie" rows="1" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="Commande à taper dans le terminal simulé"></textarea></label>`;
    const ecran = el.querySelector(".ts-ecran");
    const saisie = el.querySelector(".ts-saisie");
    const invite = el.querySelector(".ts-ligne .ts-invite");
    const panneau = el.querySelector(".ts-etape");
    const titre = el.querySelector(".ts-titre");

    const ajuster = () => { saisie.style.height = "auto"; saisie.style.height = saisie.scrollHeight + "px"; };
    const majInvite = () => {
      const p = tampon ? ">" : hote.invite();
      invite.textContent = p;
      titre.textContent = hote.invite().replace(/\$$/, "") + " · simulateur";
    };
    const ecrire = (texte, classe) => {
      const p = document.createElement("div");
      p.className = "ts-sortie" + (classe ? " " + classe : "");
      p.textContent = texte === "" ? " " : texte;
      ecran.appendChild(p);
      ecran.scrollTop = ecran.scrollHeight;
    };
    const ecrireCommande = (cmd, prompt) => {
      cmd.split("\n").forEach((ligne, k) => {
        const p = document.createElement("div");
        p.className = "ts-cmd";
        const i = document.createElement("span");
        i.className = "ts-invite"; i.textContent = k === 0 ? prompt : ">";
        p.appendChild(i);
        p.appendChild(document.createTextNode(" " + ligne));
        ecran.appendChild(p);
      });
      ecran.scrollTop = ecran.scrollHeight;
    };

    function accueil() {
      ecran.innerHTML = "";
      if (el.dataset.seul) { ecrire("Ta machine simulée : Docker, Compose et Minikube. Suis le tutoriel à droite : clique sur « Insérer dans le terminal », puis appuie sur Entrée. Tu peux aussi taper ce que tu veux : « help » liste ce qui est simulé.", "ts-info"); return; }
      ecrire(mode === "guide"
        ? "Mode guidé : suis les étapes du lab. Tape la commande, ou clique sur « Insérer la commande »."
        : "Mode libre : une machine Docker simulée rien que pour toi. Essaie, casse, recommence. Tape « help » pour la liste des commandes.", "ts-info");
    }
    // La préparation d'un lab représente une machine prête depuis un moment : le temps virtuel avance de 20 minutes.
    function preparer() {
      preparation.forEach((c) => hote.executer(c));
      if (preparation.length) SIM.horloge.avancer(20 * 60 * 1000);
      majInvite();
    }
    el.preparer = (cmds) => { preparation = cmds || []; preparer(); };

    function afficherEtape() {
      if (mode !== "guide" || !lab) { panneau.hidden = true; return; }
      panneau.hidden = false;
      if (etape >= lab.etapes.length) { panneau.innerHTML = `<div class="ts-fin">✓ Lab terminé ! Passe en mode Libre pour expérimenter à ta guise.</div>`; return; }
      const e = lab.etapes[etape];
      panneau.innerHTML = `<div class="ts-num">Étape ${etape + 1} / ${lab.etapes.length}</div>
        <div class="ts-consigne"><strong></strong><span></span></div>
        <div class="ts-actions"><code></code><button type="button" class="ts-inserer">Insérer la commande</button></div>`;
      panneau.querySelector("strong").textContent = e.titre + " · ";
      panneau.querySelector(".ts-consigne span").textContent = e.consigne;
      panneau.querySelector("code").textContent = e.commande;
      panneau.querySelector(".ts-inserer").onclick = () => { saisie.value = e.commande; ajuster(); saisie.focus(); };
    }
    function verifier(cmd) {
      if (mode !== "guide" || !lab || etape >= lab.etapes.length) return;
      const e = lab.etapes[etape];
      const norm = (s) => s.replace(/\s+/g, " ").trim();
      const re = new RegExp(e.attendu || "^" + norm(e.commande).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$");
      if (re.test(norm(cmd))) { if (e.bravo) ecrire("✓ " + e.bravo, "ts-ok"); etape++; afficherEtape(); }
      else if (e.indice) ecrire("↪ Indice : " + e.indice, "ts-indice");
    }

    // Temps de réponse réaliste : une commande ne répond jamais instantanément.
    let occupe = false; let interrompu = false;
    function latence(cmd) {
      const mots = cmd.replace(/^\s*(sudo\s+|time\s+|\w+=\S+\s+)+/, "").split(/\s+/);
      const [outil, sous, sous2] = mots;
      let avant = entre(10, 60);
      if (outil === "docker") {
        avant = sous === "compose" ? { up: entre(300, 700), down: entre(200, 500), ps: entre(150, 350), exec: entre(150, 350), config: entre(80, 200), logs: entre(80, 200) }[sous2] || entre(150, 400)
          : { run: entre(350, 900), create: entre(250, 600), pull: entre(300, 700), stop: entre(200, 500), restart: entre(300, 700), start: entre(250, 700), kill: entre(150, 400), rm: entre(150, 450),
            rmi: entre(200, 500), exec: entre(120, 350), stats: entre(900, 1600), inspect: entre(60, 180), ps: entre(60, 200), images: entre(60, 200), image: entre(60, 250), logs: entre(50, 150),
            top: entre(100, 250), version: entre(100, 300), info: entre(150, 400), build: entre(250, 500), push: entre(300, 700), network: entre(80, 250), volume: entre(60, 200) }[sous] || entre(80, 220);
      } else if (outil === "kubectl") avant = { apply: entre(300, 700), get: entre(120, 400), describe: entre(150, 450), delete: entre(300, 800), create: entre(200, 500), rollout: entre(200, 500), run: entre(600, 1200), scale: entre(150, 350), expose: entre(150, 350), top: entre(300, 600) }[sous] || entre(150, 400);
      else if (outil === "minikube") avant = entre(400, 900);
      else if (outil === "curl" || outil === "wget") avant = entre(40, 180);
      const ligne = (x, i) => {
        if (x.d) return x.d;
        if (x.lent) return entre(250, 700);
        if (/Pulling from|Downloaded newer image|Image is up to date/.test(x.t)) return entre(150, 400);
        if (/^Digest:|^Unable to find/.test(x.t)) return entre(80, 180);
        if (/^ (Container|Network|Volume|Image) .* (Started|Created|Healthy|Removed|Stopped|Pulled)\s$/.test(x.t)) return entre(80, 260);
        if (/^#\d+ (DONE|CACHED)/.test(x.t)) return entre(40, 160);
        return i === 0 ? 0 : entre(2, 12);
      };
      return { avant, ligne };
    }

    async function lancer(brut) {
      const prompt = tampon ? ">" : hote.invite();
      const cmd = tampon ? tampon.concat(brut).join("\n") : brut;
      // Ligne incomplète (heredoc sans fin, guillemet ouvert, \ final) : invite de continuation, comme bash.
      if (cmd.trim() && SIM.lexer(cmd).incomplet) {
        ecrireCommande(brut, prompt);
        tampon = cmd.split("\n"); majInvite(); return;
      }
      if (tampon) ecrireCommande(brut, ">"); else ecrireCommande(cmd, prompt);
      tampon = null;
      if (!cmd.trim()) { majInvite(); return; }
      historique.push(cmd); posHist = historique.length;
      hote.sh.historique = historique;
      const t = cmd.trim();
      if (t === "clear") { ecran.innerHTML = ""; return; }
      if (t === "reset") { hote.reinitialiser(); preparer(); accueil(); ecrire("Machine remise à zéro.", "ts-info"); majInvite(); el.dispatchEvent(new CustomEvent("ts-reset")); return; }
      if (t === "help") { aide().forEach((l) => ecrire(l)); return; }
      const lat = latence(cmd);
      occupe = true; interrompu = false; saisie.readOnly = true; el.classList.add("ts-occupe");
      await attendre(lat.avant);
      const res = hote.executer(cmd);
      let attenteVirtuelle = 0;
      const lignes = res.l;
      for (let i = 0; i < lignes.length && !interrompu; i++) {
        const x = lignes[i];
        if (x.pause !== undefined) { const r = pauseReelle(x.pause); attenteVirtuelle += Math.min(r, x.pause); await attendre(r); continue; }
        if (x.t === undefined) continue;
        if (x.t === "\u0000clear") { ecran.innerHTML = ""; continue; }
        const d = lat.ligne(x, i);
        if (d) await attendre(d);
        if (interrompu) break;
        ecrire(x.t, x.info ? "ts-info" : x.e && res.code && /^(docker:|Error|error|ERROR|curl:|sh:|bash:|cat:|ls:|rm:|mkdir:|touch:|wget:|tar:|unknown|no configuration|service |dependency|The connection|\(simulateur)/.test(x.t) ? "ts-erreur" : "");
      }
      // Le temps réellement attendu fait partie du temps virtuel déjà compté : on ne le compte pas deux fois.
      SIM.horloge.decalage -= attenteVirtuelle;
      if (interrompu) ecrire("^C");
      occupe = false; saisie.readOnly = false; el.classList.remove("ts-occupe");
      majInvite();
      ecran.scrollTop = ecran.scrollHeight;
      if (!interrompu) {
        verifier(cmd);
        el.dispatchEvent(new CustomEvent("ts-commande", { detail: { cmd, code: res.code, sortie: SIM.R.textes(res.l) } }));
      }
    }
    function aide() {
      return ["Ce terminal simule une machine Linux avec Docker, Docker Compose, Minikube et kubectl.",
        "  docker      run, ps, exec, logs, inspect, top, stats, stop, start, rm, diff, port,",
        "              build, images, image ls|rm|tag|history|inspect|save, pull, push,",
        "              volume ls|create|rm, network ls|create|rm|inspect, info, version",
        "  compose     up, down, ps, logs, exec, run, config, stop, start, restart",
        "  minikube    start, stop, status, ip, ssh, addons, profile list",
        "  kubectl     get, describe, apply, create, delete, scale, expose, run, rollout,",
        "              set image, logs, exec, port-forward, diff, top, config",
        "  Linux       ls, cd, cat, echo, printf, mkdir, rm, cp, mv, sed, grep, head, tail, wc,",
        "              du, tar, base64, curl, ss, ps, sleep, date, uname, id, cat > f <<'EOF'",
        "  Raccourcis  ↑ ↓ historique, Ctrl+C interrompt, Ctrl+L efface, « reset » remet à zéro"];
    }

    saisie.addEventListener("keydown", (ev) => {
      if (occupe) { if (ev.key === "c" && ev.ctrlKey) interrompu = true; ev.preventDefault(); return; }
      if (ev.key === "Enter" && !ev.shiftKey) {
        const v = saisie.value; saisie.value = ""; ajuster();
        // Un bloc collé de plusieurs lignes part en une fois ; ses lignes s'affichent avec l'invite de continuation.
        lancer(v); ev.preventDefault();
      } else if (ev.key === "ArrowUp" && !saisie.value.includes("\n")) { if (posHist > 0) { posHist--; saisie.value = historique[posHist]; ajuster(); } ev.preventDefault(); }
      else if (ev.key === "ArrowDown" && !saisie.value.includes("\n")) { if (posHist < historique.length - 1) { posHist++; saisie.value = historique[posHist]; } else { posHist = historique.length; saisie.value = ""; } ajuster(); ev.preventDefault(); }
      else if (ev.key === "l" && ev.ctrlKey) { ecran.innerHTML = ""; ev.preventDefault(); }
      else if (ev.key === "c" && ev.ctrlKey && !window.getSelection().toString()) { if (tampon || saisie.value) { ecrireCommande(saisie.value + "^C", tampon ? ">" : hote.invite()); tampon = null; saisie.value = ""; ajuster(); majInvite(); } ev.preventDefault(); }
    });
    saisie.addEventListener("input", ajuster);
    ecran.addEventListener("click", () => { if (!window.getSelection().toString()) saisie.focus(); });
    el.addEventListener("ts-inserer", (ev) => { saisie.value = ev.detail; ajuster(); saisie.focus(); });

    const choisirMode = (m) => {
      mode = m;
      el.querySelectorAll(".ts-mode").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.mode === m)));
      if (m === "guide") { etape = 0; hote.reinitialiser(); preparer(); }
      accueil(); afficherEtape(); majInvite();
    };
    el.querySelectorAll(".ts-mode").forEach((b) => (b.onclick = () => choisirMode(b.dataset.mode)));
    el.querySelector(".ts-reset").onclick = () => { hote.reinitialiser(); preparer(); tampon = null; etape = 0; accueil(); afficherEtape(); majInvite(); el.dispatchEvent(new CustomEvent("ts-reset")); };

    const nomLab = el.dataset.lab;
    if (el.dataset.seul) { el.querySelector(".ts-modes").hidden = true; choisirMode("libre"); }
    else if (nomLab && scriptCourant) {
      fetch(new URL(`../assets/labs/${nomLab}.json`, scriptCourant)).then((r) => r.json()).then((j) => { lab = j; preparation = j.preparation || []; choisirMode("guide"); })
        .catch(() => choisirMode("libre"));
    } else { el.querySelector('.ts-mode[data-mode="guide"]').hidden = true; choisirMode("libre"); }
  }

  /* --------------------------------------------- page de lab : terminal + tutoriel */
  const echapper = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  // Mise en forme légère dans les textes du tutoriel : **gras** et `code`.
  const enrichir = (s) => echapper(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
  const mouvementReduit = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* Conti, le robot du lab : SVG animé par CSS (classes parle, content, pensif). */
  const ROBOT = `<svg class="robot" viewBox="0 0 120 140" aria-hidden="true">
      <g class="rb-corps">
        <line x1="60" y1="8" x2="60" y2="24" stroke="#a0a4a0" stroke-width="3"/>
        <circle class="rb-lampe" cx="60" cy="8" r="6" fill="#eeff57"/>
        <rect class="rb-tete" x="22" y="24" width="76" height="56" rx="18" fill="#1f9e91"/>
        <rect x="31" y="33" width="58" height="38" rx="11" fill="#0a0006"/>
        <g class="rb-yeux"><ellipse class="rb-oeil" cx="47" cy="49" rx="6" ry="7" fill="#5affb6"/><ellipse class="rb-oeil" cx="73" cy="49" rx="6" ry="7" fill="#5affb6"/></g>
        <g class="rb-yeux-joie"><path d="M41 51 q6 -9 12 0" stroke="#5affb6" stroke-width="3.5" fill="none" stroke-linecap="round"/><path d="M67 51 q6 -9 12 0" stroke="#5affb6" stroke-width="3.5" fill="none" stroke-linecap="round"/></g>
        <rect class="rb-bouche" x="52" y="60" width="16" height="4" rx="2" fill="#5affb6"/>
        <circle cx="22" cy="52" r="5" fill="#187b73"/><circle cx="98" cy="52" r="5" fill="#187b73"/>
        <rect x="34" y="84" width="52" height="40" rx="12" fill="#1d1d1d" stroke="#1f9e91" stroke-width="2"/>
        <rect x="42" y="94" width="36" height="5" rx="2.5" fill="url(#rb-grad)"/>
        <circle cx="50" cy="110" r="3.5" fill="#ff84ef"/><circle cx="60" cy="110" r="3.5" fill="#00eaff"/><circle cx="70" cy="110" r="3.5" fill="#eeff57"/>
        <g class="rb-bras-g"><rect x="18" y="88" width="16" height="9" rx="4.5" fill="#1f9e91"/></g>
        <g class="rb-bras-d"><rect x="86" y="88" width="16" height="9" rx="4.5" fill="#1f9e91"/></g>
      </g>
      <defs><linearGradient id="rb-grad" x1="0" x2="1"><stop offset="0" stop-color="#ff1a1a"/><stop offset=".3" stop-color="#eeff57"/><stop offset=".55" stop-color="#5affb6"/><stop offset=".8" stop-color="#00eaff"/><stop offset="1" stop-color="#859cff"/></linearGradient></defs>
    </svg>`;

  function scene(nom, attente) {
    return `<div class="robot-scene${attente ? " en-attente" : ""}">
        <div class="robot-boite">${ROBOT}</div>
        <div class="robot-bulle" role="status" aria-live="polite">
          <div class="robot-nom">${echapper(nom)}</div>
          <div class="robot-texte"></div>
          <button type="button" class="robot-passer" hidden>Passer ▸</button>
        </div>
      </div>`;
  }

  // Fait parler le robot : texte tapé lettre par lettre, bouche animée. Rend une promesse.
  function dire(sceneEl, phrases, opts = {}) {
    const texte = sceneEl.querySelector(".robot-texte");
    const robot = sceneEl.querySelector(".robot");
    const passer = sceneEl.querySelector(".robot-passer");
    if (!opts.ajout) texte.innerHTML = "";
    let vite = mouvementReduit() || !!opts.instant;
    passer.hidden = vite;
    passer.onclick = () => { vite = true; };
    sceneEl.classList.add("parle");
    return (async () => {
      for (const phrase of phrases) {
        const p = document.createElement("p");
        if (opts.classe) p.className = opts.classe;
        texte.appendChild(p);
        const html = enrichir(phrase);
        if (vite) { p.innerHTML = html; continue; }
        // On tape le texte brut, puis on remet la mise en forme à la fin de la phrase.
        const brut = Array.from(phrase.replace(/\*\*|`/g, "")); // par caractère, émojis compris
        for (let k = 1; k <= brut.length; k++) {
          if (vite) break;
          p.textContent = brut.slice(0, k).join("");
          const ch = brut[k - 1];
          await attendre(/[.!?]/.test(ch) ? 220 : /[,:;]/.test(ch) ? 110 : 20 + Math.random() * 18);
        }
        p.innerHTML = html;
        if (!vite) await attendre(380);
      }
      sceneEl.classList.remove("parle");
      passer.hidden = true;
      void robot;
    })();
  }

  function reagir(sceneEl, humeur) {
    sceneEl.classList.remove("content", "pensif");
    void sceneEl.offsetWidth; // relance l'animation
    sceneEl.classList.add(humeur);
  }

  function popXP(sceneEl, points) {
    const pop = document.createElement("div");
    pop.className = "xp-pop";
    pop.textContent = `+${points} XP`;
    sceneEl.appendChild(pop);
    setTimeout(() => pop.remove(), 1600);
  }

  function creerLab(racine) {
    if (racine.dataset.pret) return;
    racine.dataset.pret = "1";
    const nom = racine.dataset.lab;
    racine.innerHTML = `<div class="lab-split">
        <section class="lab-gauche"><div class="terminal-sim" data-seul="1"></div></section>
        <aside class="lab-droite"><div class="lab-chargement">Chargement du lab…</div></aside>
      </div>`;
    const term = racine.querySelector(".terminal-sim");
    const guide = racine.querySelector(".lab-droite");
    creer(term);
    fetch(new URL(`../assets/labs/${nom}.json`, scriptCourant)).then((r) => r.json()).then((lab) => {
      term.preparer(lab.preparation || []);
      let courant = 0; let xp = 0;
      const etapes = lab.etapes;
      const nomRobot = lab.robotNom || "Conti";
      const indiceUtilise = new Set();
      guide.innerHTML = `
        <header class="lab-entete">
          <div class="lab-sur">Lab interactif${lab.duree ? " · " + echapper(lab.duree) : ""}</div>
          <h2 class="lab-titre">${echapper(lab.titre)}</h2>
          <div class="lab-progression"><div class="lab-barre"><span></span></div><span class="lab-compte"></span><span class="lab-xp">0 XP</span></div>
          <div class="lab-accueil">${scene(nomRobot)}</div>
        </header>
        <ol class="lab-etapes">${etapes.map((e, i) => `
          <li class="lab-etape" data-i="${i}">
            <button type="button" class="lab-tete"><span class="lab-pastille">${i + 1}</span><span class="lab-nom">${echapper(e.titre)}</span></button>
            <div class="lab-corps">
              ${scene(nomRobot, true)}
              <div class="lab-details">
                ${e.pourquoi ? `<p class="lab-pourquoi">${enrichir(e.pourquoi)}</p>` : ""}
                <p class="lab-consigne"><strong>À faire :</strong> ${enrichir(e.consigne)}</p>
                <div class="lab-commande"><code>${echapper(e.commande)}</code>
                  <span class="lab-boutons"><button type="button" class="lab-inserer">Insérer dans le terminal</button><button type="button" class="lab-copier">Copier</button></span></div>
                ${e.options && e.options.length ? `<dl class="lab-options">${e.options.map(([o, x]) => `<dt><code>${echapper(o)}</code></dt><dd>${enrichir(x)}</dd>`).join("")}</dl>` : ""}
                ${e.sortie ? `<div class="lab-attendu"><div class="lab-libelle">Tu dois voir à peu près :</div><pre>${echapper(e.sortie)}</pre></div>` : ""}
                ${e.remarque ? `<p class="lab-remarque"><strong>À remarquer :</strong> ${enrichir(e.remarque)}</p>` : ""}
                ${e.indice ? `<details class="lab-indice"><summary>Besoin d'un indice ?</summary><p>${enrichir(e.indice)}</p></details>` : ""}
              </div>
            </div>
          </li>`).join("")}
        </ol>
        <div class="lab-final" hidden>
          <div class="lab-final-scene">${scene(nomRobot)}</div>
          ${lab.badge ? `<div class="lab-badge"><span class="lab-badge-icone">🏅</span><span><strong>Badge débloqué</strong><br>${echapper(lab.badge)}</span></div>` : ""}
          ${lab.conclusion ? `<p>${enrichir(lab.conclusion)}</p>` : ""}
          ${lab.retour ? `<p><a class="md-button md-button--primary" href="${echapper(lab.retour.lien)}">${echapper(lab.retour.texte)}</a></p>` : ""}
        </div>`;
      const items = [...guide.querySelectorAll(".lab-etape")];
      const joue = new Set();

      const maj = () => {
        items.forEach((li, i) => {
          li.classList.toggle("fait", i < courant);
          li.classList.toggle("actif", i === courant);
          li.classList.toggle("ouvert", i === courant || li.classList.contains("deplie"));
        });
        const n = Math.min(courant, etapes.length);
        guide.querySelector(".lab-barre span").style.width = Math.round((n / etapes.length) * 100) + "%";
        guide.querySelector(".lab-compte").textContent = `${n} / ${etapes.length} étapes`;
        guide.querySelector(".lab-xp").textContent = `${xp} XP`;
        guide.querySelector(".lab-final").hidden = courant < etapes.length;
      };

      // Présentation d'une étape : le robot parle d'abord, puis les explications apparaissent.
      const presenter = async (i, instant) => {
        const li = items[i]; const e = etapes[i];
        const sc = li.querySelector(".robot-scene");
        const details = li.querySelector(".lab-details");
        sc.classList.remove("en-attente");
        if (joue.has(i) || instant) {
          details.classList.add("visible");
          if (!joue.has(i)) { joue.add(i); await dire(sc, e.robot || [e.consigne], { instant: true }); }
          return;
        }
        joue.add(i);
        details.classList.remove("visible");
        sc.classList.add("entree");
        await attendre(mouvementReduit() ? 0 : 450);
        await dire(sc, e.robot || [e.consigne]);
        details.classList.add("visible");
      };

      items.forEach((li, i) => {
        const e = etapes[i];
        li.querySelector(".lab-tete").onclick = () => { li.classList.toggle("deplie"); maj(); if (li.classList.contains("ouvert")) presenter(i, true); };
        li.querySelector(".lab-inserer").onclick = () => term.dispatchEvent(new CustomEvent("ts-inserer", { detail: e.commande }));
        li.querySelector(".lab-copier").onclick = (ev) => {
          const bouton = ev.currentTarget;
          (navigator.clipboard ? navigator.clipboard.writeText(e.commande) : Promise.reject(new Error("presse-papiers indisponible")))
            .then(() => { bouton.textContent = "Copié ✓"; }, () => { bouton.textContent = "Sélectionne et copie"; });
          setTimeout(() => { bouton.textContent = "Copier"; }, 1600);
        };
        const ind = li.querySelector(".lab-indice");
        if (ind) ind.addEventListener("toggle", () => { if (ind.open) indiceUtilise.add(i); });
      });

      const norm = (s) => s.replace(/\s+/g, " ").trim();
      // Les deux premiers mots (« docker run », « curl http… ») : sert à distinguer une tentative ratée d'une exploration.
      const debut = (s) => norm(s).split(" ").slice(0, 2).join(" ");
      term.addEventListener("ts-commande", async (ev) => {
        if (courant >= etapes.length) return;
        const i = courant; const e = etapes[i]; const li = items[i];
        const sc = li.querySelector(".robot-scene");
        const re = new RegExp(e.attendu || "^" + norm(e.commande).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$");
        if (re.test(norm(ev.detail.cmd))) {
          const points = indiceUtilise.has(i) ? 10 : 15;
          xp += points; courant++;
          sc.scrollIntoView({ behavior: "smooth", block: "nearest" });
          reagir(sc, "content"); popXP(sc, points);
          li.querySelector(".lab-details").classList.add("visible");
          await dire(sc, ["✓ " + (e.bravo || "Bien joué !")], { ajout: true, classe: "robot-bravo", instant: false });
          maj();
          await attendre(mouvementReduit() ? 0 : 700);
          if (courant < etapes.length) {
            items[courant].scrollIntoView({ behavior: "smooth", block: "start" });
            presenter(courant);
          } else {
            const fin = guide.querySelector(".lab-final");
            fin.scrollIntoView({ behavior: "smooth", block: "start" });
            const scf = fin.querySelector(".robot-scene");
            scf.classList.add("entree"); reagir(scf, "content");
            dire(scf, lab.robotFin || ["Bravo, tu as terminé le lab !", `Total : **${xp} XP**.`]);
          }
        } else if (debut(ev.detail.cmd) === debut(e.commande)) {
          reagir(sc, "pensif");
          sc.querySelectorAll(".robot-indice").forEach((n) => n.remove()); // un seul indice affiché à la fois
          sc.scrollIntoView({ behavior: "smooth", block: "nearest" });
          if (e.indice) {
            indiceUtilise.add(i);
            const d = li.querySelector(".lab-indice"); if (d) d.open = true;
          }
          dire(sc, ["Hmm, pas tout à fait… " + (e.indice || "Compare ta commande avec celle de la consigne, ou clique sur « Insérer dans le terminal ».")], { ajout: true, classe: "robot-indice" });
        }
      });
      term.addEventListener("ts-reset", () => {
        courant = 0; xp = 0; indiceUtilise.clear(); joue.clear();
        items.forEach((li) => { li.classList.remove("deplie"); li.querySelector(".lab-details").classList.remove("visible"); });
        maj(); presenter(0);
      });

      maj();
      (async () => {
        const acc = guide.querySelector(".lab-accueil .robot-scene");
        acc.classList.add("entree");
        await attendre(mouvementReduit() ? 0 : 300);
        await dire(acc, lab.robotIntro || (lab.intro ? [lab.intro] : ["C'est parti !"]));
        presenter(0);
      })();
    }).catch(() => { guide.innerHTML = '<p class="lab-chargement">Impossible de charger le tutoriel de ce lab.</p>'; });
  }

  function tout() { document.querySelectorAll(".lab-page").forEach(creerLab); document.querySelectorAll(".terminal-sim").forEach(creer); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", tout); else tout();
  if (window.document$ && window.document$.subscribe) window.document$.subscribe(tout);
  new MutationObserver(tout).observe(document.documentElement, { childList: true, subtree: true });
  window.DockerSim = { creer, creerLab }; // pour les tests
})();
