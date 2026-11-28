# Modèle de menaces

## Ce qu'on protège

L'**argent** des wallets (solde = somme d'un registre), le **stock**, l'**exclusivité** de la machine, les **secrets** (PIN, poivre) et la **traçabilité** des actions administrateur.

## Acteurs

Client honnête · client malveillant (veut du crédit ou des boissons gratuits, ou voler un wallet) · tiers sans compte · administrateur négligent (poste laissé ouvert) · attaquant ayant volé une sauvegarde de la base · attaquant ayant une injection SQL ou un bug dans l'API.

## Menaces et défenses

| Menace                                                      | Défense en place                                                                                                                    | Preuve                                                                                            |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Deviner un PIN (1 million de combinaisons)                  | 5 essais puis verrouillage 5 min ; **tentative réservée avant vérification** (essais parallèles bornés) ; limitation par adresse IP | Tests : 50 essais parallèles = 5 vérifications                                                    |
| Retrouver les PIN dans une sauvegarde volée                 | argon2id **+ poivre hors base**                                                                                                     | Test : avec un autre poivre, la même base ne valide aucun PIN                                     |
| Énumérer les comptes                                        | Réponse identique (inconnu / mauvais PIN / verrouillé), vérification factice de même coût                                           | Test                                                                                              |
| Voler une session                                           | Cookie `HttpOnly` + `SameSite=Strict` + `Secure` ; jeton stocké haché ; session client validée contre l'état de la machine          | Tests + essai en HTTPS réel                                                                       |
| CSRF                                                        | `SameSite=Strict` + refus de toute `Origin` inconnue                                                                                | Tests                                                                                             |
| XSS                                                         | CSP stricte (aucun script/style en ligne, vérifié par un test), React échappe les sorties                                           | Test de garde + Caddy en HTTPS                                                                    |
| Créer de l'argent ou du stock « à la main »                 | Solde et stock maintenus **par déclencheurs** ; le rôle applicatif n'a aucun droit d'écriture directe ; registres en ajout seul     | Suite HTTP rejouée sous le rôle restreint ; un test a prouvé qu'une erreur de droits est détectée |
| Double débit (clic double, requête rejouée, réponse perdue) | Clés d'idempotence (commande) et d'insertion (billet) ; unicité en base                                                             | Tests unitaires, bout en bout avec réponses perdues, test de charge                               |
| Deux clients sur la machine                                 | État global verrouillé par transaction                                                                                              | Test de charge : 1 connexion sur 8 simultanées                                                    |
| Distribution interrompue                                    | Unité enregistrée à la livraison ; reprise au démarrage ; délai de 10 s par unité                                                   | Tests de crash simulé, reprise sur le vrai serveur                                                |
| Injection SQL                                               | Requêtes paramétrées ; identifiants non-uuid jamais transmis à SQL                                                                  | Test d'injection                                                                                  |
| Fuite d'information                                         | Erreurs 500 génériques ; journaux sans secret                                                                                       | Tests                                                                                             |
| Poste administrateur laissé ouvert                          | Session admin : 30 min d'inactivité, 8 h maximum                                                                                    | Tests                                                                                             |
| Dépendance vulnérable / secret commité                      | `pnpm audit`, analyse de secrets, mises à jour automatiques en CI                                                                   | Audit local : aucune vulnérabilité connue ; aucun secret détecté                                  |

## Risques résiduels (à connaître)

- **Le billet est simulé par le navigateur** : en l'absence de vrai monnayeur, un client peut « s'octroyer » des billets (dans la limite du plafond de 100 000 Ar et du débit par IP). La sécurité de l'argent réel exigerait un vrai matériel de confiance.
- **Verrouillage ciblé** : quiconque connaît un identifiant peut verrouiller ce compte 5 min en boucle (compromis assumé contre la force brute).
- **Quota par adresse IP partagé** derrière un NAT (voir DEPLOIEMENT.md).
- **Chaque tentative de connexion sur une machine occupée coûte un hachage argon2** (le serveur vérifie les identifiants avant de regarder l'état de la machine) : borné par la limitation de débit, mais c'est du calcul.
- **Une unité livrée après le délai de 10 s est remboursée** (donc offerte) ; elle est journalisée.
- **Pas d'authentification à deux facteurs**, pas de réinitialisation par e-mail, pas de journal des connexions échouées.
- **Aucune alerte automatique** (pas de métriques) ; pas de chiffrement de la base au repos (à confier au disque ou à l'hébergeur).
- **Les images Docker et les parcours Playwright n'ont pas pu être exécutés dans l'environnement de développement** : ils le sont en CI (voir `.github/workflows/ci.yml`).
