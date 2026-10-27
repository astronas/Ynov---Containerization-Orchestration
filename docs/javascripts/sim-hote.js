/* Simulateur, la machine de l'élève : système de fichiers, shell bash, moteur Docker et modules branchés. */
(function (G) {
  "use strict";
  const SIM = G.SIM; const D = SIM.docker; const H = SIM.horloge;
  SIM.noyauVersion = "6.18.33.2-microsoft-standard-WSL2";
  SIM.nbCpu = 4;
  SIM.commandesExtra = SIM.commandesExtra || {};

  class Hote {
    constructor() { this.reinitialiser(); }
    reinitialiser() {
      const fs = new SIM.FSMemoire({ uid: 1000, gid: 1000 });
      ["/bin", "/dev", "/etc", "/home", "/opt", "/proc", "/root", "/run", "/srv", "/sys", "/usr", "/usr/bin", "/usr/local", "/usr/local/bin", "/var", "/var/lib", "/var/lib/docker", "/var/log"].forEach((p) => fs.mkdir(p, { parents: true, uid: 0, gid: 0 }));
      fs.mkdir("/tmp", { uid: 0, gid: 0, mode: 0o1777 });
      fs.mkdir("/home/eleve", { uid: 1000, gid: 1000 });
      fs.ecrire("/etc/os-release", 'PRETTY_NAME="Ubuntu 26.04 LTS"\nNAME="Ubuntu"\nVERSION_ID="26.04"\nVERSION="26.04 LTS (Resolute Raccoon)"\nVERSION_CODENAME=resolute\nID=ubuntu\nID_LIKE=debian\nHOME_URL="https://www.ubuntu.com/"\n', { uid: 0, gid: 0 });
      fs.ecrire("/etc/hostname", "lab\n", { uid: 0, gid: 0 });
      fs.ecrire("/etc/passwd", "root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin\nwww-data:x:33:33:www-data:/var/www:/usr/sbin/nologin\neleve:x:1000:1000:Eleve:/home/eleve:/bin/bash\n", { uid: 0, gid: 0 });
      fs.ecrire("/etc/group", "root:x:0:\nadm:x:4:eleve\nsudo:x:27:eleve\nwww-data:x:33:\neleve:x:1000:\ndocker:x:984:eleve\n", { uid: 0, gid: 0 });
      ["null", "zero", "urandom", "random"].forEach((n) => fs.ecrire("/dev/" + n, "", { uid: 0, gid: 0, mode: 0o666 }));
      fs.stat("/dev/urandom").special = "urandom"; fs.stat("/dev/random").special = "urandom";
      this.fs = fs;
      this.sh = new SIM.Shell({
        fs, cwd: "/home/eleve", uid: 1000, variante: "bash",
        env: { HOME: "/home/eleve", USER: "eleve", LOGNAME: "eleve", SHELL: "/bin/bash", PWD: "/home/eleve", LANG: "C.UTF-8", TERM: "xterm-256color", PATH: "/home/eleve/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" },
        commandes: Object.assign({}, SIM.UNIX, D.commandesHote, SIM.commandesExtra), ctx: { hote: this },
      });
      this.sh.historique = [];
      this.sh.tty = true;
      this.m = new D.Moteur(this);
      (SIM.surReinit || []).forEach((f) => f(this));
    }
    executer(ligne) {
      SIM.hoteCourant = this;
      const r = this.sh.executer(ligne);
      // Messages des tâches de fond (port-forward…) arrivés pendant la commande : affichés avant sa sortie.
      if (SIM.fondEnAttente && SIM.fondEnAttente.length) r.l = SIM.fondEnAttente.splice(0).concat(r.l);
      return r;
    }
    invite() {
      const c = this.sh.cwd; const h = this.sh.env.HOME;
      const court = c === h ? "~" : c.startsWith(h + "/") ? "~" + c.slice(h.length) : c;
      return `eleve@lab:${court}$`;
    }
  }
  SIM.Hote = Hote;
})(typeof window !== "undefined" ? window : globalThis);
