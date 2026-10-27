*[PID]: Process ID : le numéro qui identifie un processus en cours d'exécution
*[UID]: User ID : le numéro qui identifie un utilisateur Linux (0 = root, l'administrateur)
*[GID]: Group ID : le numéro qui identifie un groupe d'utilisateurs Linux
*[CPU]: le processeur, qui exécute les calculs
*[RAM]: la mémoire vive, rapide mais vidée à l'arrêt
*[DNS]: l'annuaire qui traduit un nom (db, google.com) en adresse IP
*[IP]: l'adresse d'une machine ou d'un conteneur sur un réseau
*[TCP]: le protocole réseau qui transporte la plupart des échanges (web, bases de données)
*[HTTP]: le protocole du web : un client demande, un serveur répond
*[HTTPS]: HTTP chiffré avec TLS
*[TLS]: le chiffrement des échanges réseau (le cadenas du navigateur)
*[NAT]: la traduction d'adresse qui fait sortir plusieurs machines par une seule adresse
*[API]: une interface que des programmes appellent pour dialoguer entre eux
*[YAML]: un format de fichier de configuration lisible, structuré par l'indentation
*[JSON]: un format de données texte entre accolades, très utilisé par les API
*[OOM]: Out Of Memory : la mémoire est épuisée, le noyau tue un processus
*[VM]: machine virtuelle : un ordinateur complet simulé, avec son propre système
*[OS]: système d'exploitation (Linux, Windows…)
*[CVE]: une faille de sécurité connue, répertoriée avec un numéro unique
*[SBOM]: la liste de tous les composants logiciels contenus dans une image
*[OCI]: le standard ouvert qui définit le format des images et des conteneurs
*[CRI]: l'interface standard par laquelle Kubernetes pilote un moteur de conteneurs
*[CNI]: l'interface standard qui branche les conteneurs au réseau dans Kubernetes
*[IaC]: Infrastructure as Code : l'infrastructure décrite dans des fichiers versionnés
*[CI]: intégration continue : chaque modification est testée automatiquement
*[CD]: déploiement continu : ce qui passe les tests est livré automatiquement
*[SSH]: la connexion sécurisée à distance à une machine
*[URL]: une adresse web
*[namespace]: sous Linux, une vue isolée d'une ressource (processus, réseau, fichiers) ; dans Kubernetes, un espace de rangement qui sépare les objets d'un cluster
*[namespaces]: sous Linux, des vues isolées des ressources (processus, réseau, fichiers) ; dans Kubernetes, des espaces de rangement qui séparent les objets d'un cluster
*[cgroup]: control group : un compteur avec plafond sur la mémoire, le CPU ou les processus
*[cgroups]: control groups : des compteurs avec plafond sur la mémoire, le CPU ou les processus
*[capability]: un morceau des pouvoirs de root, qu'on peut donner ou retirer à part
*[capabilities]: les morceaux des pouvoirs de root, qu'on peut donner ou retirer un par un
*[démon]: un programme qui tourne en arrière-plan en permanence (ici, le moteur Docker)
*[daemon]: un programme qui tourne en arrière-plan en permanence (ici, le moteur Docker)
*[digest]: l'empreinte sha256 d'une image : elle désigne un contenu exact, contrairement au tag
*[registre]: le serveur qui stocke et distribue les images (Docker Hub, GHCR…)
*[healthcheck]: une sonde lancée régulièrement pour savoir si un service répond vraiment
*[bind mount]: un dossier de la machine hôte branché dans le conteneur
*[tmpfs]: un dossier en mémoire vive, vidé à l'arrêt du conteneur
*[kubelet]: l'agent Kubernetes de chaque machine, qui lance les pods
*[containerd]: le moteur qui exécute réellement les conteneurs, sous Docker et Kubernetes
*[runc]: le petit programme qui crée le conteneur en appelant le noyau Linux
*[etcd]: la base de données où Kubernetes stocke tout l'état du cluster
*[kubectl]: l'outil en ligne de commande pour piloter Kubernetes
*[Minikube]: un cluster Kubernetes complet sur un seul poste, pour apprendre
*[root]: l'administrateur d'un système Linux, qui a tous les droits
