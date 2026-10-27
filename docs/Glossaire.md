# Glossaire

<p class="lead">Les mots du cours, expliqués simplement. Dans les pages, ces mots sont <strong>soulignés en pointillés</strong> : il suffit de passer la souris dessus.</p>

## :material-cube-outline: Conteneurs et images

| Mot | En clair |
|---|---|
| **Conteneur** | un programme lancé dans une bulle isolée par le noyau Linux : il croit être seul sur la machine |
| **Image** | le modèle figé à partir duquel on crée des conteneurs : les fichiers et les réglages de départ |
| **Couche** | une tranche de l'image, ajoutée par une instruction du Dockerfile ; les couches s'empilent |
| **Dockerfile** | la recette qui décrit comment construire une image, ligne par ligne |
| **Tag** | l'étiquette lisible d'une image (`nginx:1.27`) ; elle peut être déplacée vers une autre version |
| **Digest** | l'empreinte `sha256:…` d'une image : elle désigne un contenu exact, qui ne change jamais |
| **Registre** | le serveur qui stocke et distribue les images (Docker Hub, GHCR, un registre privé) |
| **Moteur, démon** | le programme Docker qui tourne en arrière-plan et fait le travail (`dockerd`) |
| **Client** | la commande `docker` que l'on tape ; elle envoie des ordres au moteur |
| **containerd, runc** | les pièces sous le moteur qui créent réellement les conteneurs |

## :material-shield-outline: Isolation et sécurité

| Mot | En clair |
|---|---|
| **Noyau** | le cœur de Linux, qui gère la mémoire, les processus et le matériel ; tous les conteneurs le partagent |
| **Processus** | un programme en cours d'exécution, identifié par un numéro (PID) |
| **Namespace** | une vue isolée du système : le conteneur ne voit que ses processus, son réseau, ses fichiers |
| **Cgroup** | un compteur avec plafond : mémoire, CPU, nombre de processus |
| **root** | l'administrateur Linux (UID 0), qui a tous les droits |
| **Capability** | un morceau des pouvoirs de root, qu'on peut retirer un par un |
| **no-new-privileges** | une option qui empêche un processus de gagner des droits en cours de route |
| **Secret** | une donnée sensible (mot de passe, clé) fournie au conteneur sans être écrite dans l'image |
| **CVE** | une faille de sécurité connue et numérotée |

## :material-lan: Réseau et stockage

| Mot | En clair |
|---|---|
| **Port** | un numéro de « porte » sur une machine : 80 pour le web, 3306 pour MariaDB |
| **Publier un port** | ouvrir une porte de la machine hôte vers le conteneur (`-p 8080:80`) |
| **Réseau Docker** | un réseau privé où les conteneurs se trouvent par leur nom |
| **Volume** | un espace de stockage géré par Docker, qui survit à la suppression du conteneur |
| **Bind mount** | un dossier de la machine hôte branché dans le conteneur |
| **Healthcheck** | une sonde régulière qui vérifie qu'un service répond vraiment |

## :material-kubernetes: Orchestration

| Mot | En clair |
|---|---|
| **Orchestrateur** | le chef d'orchestre qui répartit les conteneurs sur plusieurs machines et les relance |
| **Cluster** | un groupe de machines pilotées ensemble par Kubernetes |
| **Nœud** | une machine du cluster |
| **Pod** | la plus petite unité de Kubernetes : un ou quelques conteneurs qui partagent le réseau |
| **ReplicaSet** | garantit qu'il existe toujours le bon nombre de copies d'un pod |
| **Deployment** | ce qu'on écrit pour déployer une application : version, nombre de copies, mise à jour |
| **Service** | une adresse stable devant un groupe de pods qui, eux, changent |
| **Ingress** | la porte d'entrée HTTP du cluster, qui aiguille selon le nom de domaine ou le chemin |
| **État désiré** | ce qu'on déclare vouloir ; Kubernetes corrige en permanence l'écart avec la réalité |
| **kubectl** | l'outil en ligne de commande de Kubernetes |
| **Minikube** | un cluster Kubernetes complet sur un seul poste, pour apprendre |
