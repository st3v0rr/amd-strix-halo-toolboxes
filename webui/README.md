# Strix Halo WebUI

Ein Webinterface für die llama.cpp-Toolboxes dieses Repositories: Modelle
herunterladen und verwalten, Server starten und stoppen, Live-Logs mitlesen,
Images und die App selbst aktualisieren — alles im Browser statt per SSH.

Läuft als `systemd --user`-Dienst auf der Strix-Halo-Box und startet nach einem
Reboot automatisch mit.

## Installation

```bash
git clone https://github.com/st3v0rr/amd-strix-halo-toolboxes.git
cd amd-strix-halo-toolboxes/webui
./install.sh
```

Der Installer prüft die Voraussetzungen, baut das Frontend, legt die
Konfiguration an, installiert die systemd-Unit und aktiviert Lingering. Am Ende
gibt er die URL und ein **einmalig angezeigtes** Passwort aus.

### Als normaler Benutzer oder als root?

Der Installer erkennt beides und wählt die passende Betriebsart:

| | als normaler Benutzer | als root |
|---|---|---|
| Unit | `systemd --user` + Lingering | System-Unit in `/etc/systemd/system` |
| Podman | rootless | rootful |
| Konfiguration | `~/.config/strix-halo-webui/` | `/root/.config/strix-halo-webui/` |
| Autostart | über Lingering | über `WantedBy=multi-user.target` |

Entscheidend ist, **wem deine Podman-Images und Container gehören**. Wer die Box
bisher als root bedient hat, sollte auch so installieren — sonst sieht die App
die vorhandenen Images nicht und müsste alles neu ziehen.

Der Preis der root-Variante: Wer das Webinterface übernimmt, ist root. Im LAN
hinter einer Firewall ist das für viele akzeptabel; wer es strenger mag, legt
einen eigenen Benutzer an, fügt ihn den Gruppen `video` und `render` hinzu und
installiert als dieser Benutzer.

Optionen:

```
--port PORT           Port des Webinterfaces (Default 8420)
--bind ADDR           Bind-Adresse (Default 0.0.0.0; 127.0.0.1 hinter einem Reverse-Proxy)
--models-dir DIR      Modellverzeichnis (Default ~/models)
--open-firewall       firewall-cmd fuer den Port ausfuehren
--no-start            Unit installieren, aber nicht starten
```

Ein erneuter Lauf ist idempotent und überschreibt die Zugangsdaten nicht.

### Voraussetzungen

| Werkzeug | Nötig für | Fehlt es? |
|---|---|---|
| Node ≥ 20.11 | die App | `sudo dnf install nodejs22` |
| podman | Container | `sudo dnf install podman` |
| git | Self-Update | Pflicht |
| python3 | VRAM-Schätzer | Schätzung bleibt deaktiviert |
| `hf` | Modell-Downloads | `pipx install "huggingface_hub[cli]"` |

Der Benutzer muss in den Gruppen `video` und `render` sein, sonst schlägt
`--device /dev/kfd` fehl:

```bash
sudo usermod -aG video,render "$USER"   # danach neu anmelden
```

## Modelle laden

Unter **Llama.cpp-Modelle → Modell herunterladen** wird ein Repository auf Hugging Face
gesucht und eine Quantisierung ausgewählt. Der Dialog schließt sich, sobald der
Download angelegt ist — ab da steht er in der Tabelle **Downloads** auf
derselben Seite, mit Fortschritt, Tempo und Restzeit.

Die Tabelle ist die einzige Stelle, an der ein Download gesteuert wird:

- **Abbrechen** hält ihn an. Angefangene Dateien bleiben liegen.
- **Fortsetzen** nimmt einen abgebrochenen, fehlgeschlagenen oder durch einen
  Neustart unterbrochenen Download wieder auf; `hf` setzt an den vorhandenen
  Teildateien an, lädt also nicht von vorn.
- **Verwerfen** räumt einen erledigten Eintrag weg.

Fertige Downloads verschwinden aus der Tabelle und stehen darüber in der
Modell-Liste. Der Fortschritt hängt nicht am Browser: Die Seite darf geschlossen
werden, der Download läuft auf der Box weiter, und ein Dienstneustart macht aus
ihm einen Eintrag „Unterbrochen“ statt eines verlorenen Downloads.

### Vision-Modelle

Multimodale Modelle brauchen neben den Gewichten einen Projektor
(`mmproj-*.gguf`). Beim Download eines Vision-Repos ist er einfach mit
auszuwählen; er landet neben der Quantisierung im selben Ordner.

Auf der Modell-Seite steht er nicht bei den Modellen, sondern in einer eigenen
Tabelle **Vision-Projektoren** — allein startbar ist er nicht. Im Dialog
**Server starten** wird er zum gewählten Modell automatisch gefunden und als
`--mmproj` übergeben; das Feld lässt sich auf einen anderen Projektor umstellen
oder leeren. Gesucht wird im Ordner des Modells und eine Ebene darüber, damit
auch große Quantisierungen in einem eigenen Shard-Ordner ihren Projektor finden.

Ohne Projektor startet ein Vision-Modell zwar, nimmt aber keine Bilder an.

### Download bleibt bei 0 % stehen

Mit gesetztem Token lädt `huggingface_hub` über **Xet**, und dieser Weg bleibt
in manchen Netzen ohne Fehlermeldung hängen — auch auf der Konsole, unabhängig
von dieser Anwendung. Zwei Wege aus der Sackgasse, beide unter
**Einstellungen → Hugging Face**:

- **Xet-Übertragung deaktivieren** — erzwingt einfaches HTTPS
  (`HF_HUB_DISABLE_XET=1`). Der Token bleibt nutzbar, gated Repositories also
  weiterhin erreichbar. Das ist meist die bessere Wahl.
- **Token entfernen** — öffentliche Repos laden dann wieder ohne Xet.

## ComfyUI

Neben llama.cpp lässt sich **ComfyUI** für Bild- und Videogenerierung betreiben.
Grundlage ist kyuz0s zweites Repo,
[amd-strix-halo-comfyui-toolboxes](https://github.com/kyuz0/amd-strix-halo-comfyui-toolboxes).
Dessen Image ist wie die llama.cpp-Toolboxen eines zum Reinsteigen.
`toolboxes_comfyui/Dockerfile.comfyui` ist eine Kopie ihres Dockerfiles, bei der
nur der abschließende `CMD` den Server startet statt einer Shell — ein Diff
gegen ihre Datei zeigt genau diesen Unterschied und sonst nichts. Ihr
Build-Kontext (`scripts/` und `workflows/`) liegt daneben im Fork, damit
`toolboxes_comfyui/build.sh` ohne fremdes Repository baut; Herkunft, Revision
und Nachziehen stehen in
[toolboxes_comfyui/UPSTREAM.md](../toolboxes_comfyui/UPSTREAM.md).

Auf der Server-Seite legt **ComfyUI starten** einen Container an — Image,
Host-Port, Name. Mehr braucht es nicht: kein
Modell (das nennt der Workflow selbst), kein Context, kein API-Key. Auf der
Detailseite führt **Oberfläche öffnen** zur ComfyUI-Weboberfläche.

> [!WARNING]
> ComfyUI hat **keine Anmeldung**. Wer den Port erreicht, kann Workflows
> ausführen und Dateien auf der Box lesen und schreiben. Auf der Netzwerk-Seite
> steht Port 8000 deshalb mit derselben Warnung wie der RPC-Port und ist auch
> ohne laufenden Container aufgeführt — gib ihn nur für eine Quelle frei, siehe
> [Netzwerk und Firewall](#netzwerk-und-firewall).

Zwei Dinge unterscheiden das Fork-Image vom Original, beide nötig für den
Serverbetrieb:

- `--listen 0.0.0.0`. Upstreams Alias hat es nicht, ComfyUI bindet dann
  `127.0.0.1` — im Container heißt das, dass ein veröffentlichter Port ins Leere
  zeigt.
- `TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL` und `TORCH_BLAS_PREFER_HIPBLASLT`
  als `ENV`. Upstream setzt sie in `/etc/profile.d/`, was nur eine Login-Shell
  liest; ein Container, der direkt Python startet, bekäme sie nicht und liefe
  langsamer, ohne dass etwas darauf hinweist.

### ComfyUI-Modelle

Eigene Seite, getrennt von den GGUFs: andere Ordner, andere Dateien, andere
Werkzeuge. Sie zeigt die acht Ordner, die ComfyUI kennt (`checkpoints`,
`loras`, `vae`, `diffusion_models`, …) mit Größe und Inhalt — leere inklusive,
weil ein leeres `loras/` eine Aussage ist. Ordner, die ComfyUI *nicht* liest,
werden als **unbekannt** markiert: dort belegen Dateien Platz, ohne je gefunden
zu werden.

**Herunterladen** startet die Skripte, die im Image liegen (`get_wan22.sh`,
`get_qwen_image.sh`, `get_ltx2.sh`, `get_hunyuan15.sh`, `get_minimax_h3.sh`) in
einem Wegwerf-Container mit dem Modellverzeichnis gemountet. Die Skripte sind
getestet, kennen die richtigen Zielordner und setzen abgebrochene Downloads
fort — deshalb werden sie benutzt statt nachgebaut. Der Fortschritt läuft über
dieselbe Download-Liste wie die GGUF-Downloads.

Bei den meisten Familien muss zuerst der Eintrag **Gemeinsame Teile** geladen
werden; er bringt Text-Encoder und VAEs, auf die die eigentlichen Modelle
aufbauen.

**Löschen** verlangt, dass ComfyUI vorher gestoppt ist. Anders als bei einem
llama-Server, dessen Modell in seinen Labels steht, lässt sich von außen nicht
sagen, welche Datei ein Workflow gerade lädt.

### Speculative Decoding

Ein kleines Modell rät mehrere Tokens voraus, das große prüft sie in einem
Durchgang. Das Ergebnis ist identisch, nur schneller — bei Qwen3.8-Flash-Next
laut Unsloth 1,3- bis 1,7-fach.

Im Start-Dialog und im Profil wählst du eine Strategie und **dazu immer ein
Draft-Modell**. Das ist keine Bequemlichkeit, sondern Absicht: `--spec-type`
allein nimmt llama-server an und entwirft dann nichts. Die MTP-Köpfe für
Qwen3.8-Flash-Next liegen in einem Unterordner `MTP/`, den die automatische
Suche nicht durchsucht — es gäbe keinen Fehler, keine Beschleunigung und keinen
Hinweis darauf. Ohne Draft-Modell wird der Start deshalb abgelehnt.

| Strategie | Was als Draft-Modell taugt |
| :--- | :--- |
| `draft-mtp` | Der MTP-Kopf zum Modell; für Qwen3.8-Flash-Next `mtp-…-shared-Q8_0.gguf` aus dem `MTP/`-Ordner des Repositories |
| `draft-simple` | Ein beliebiges kleineres Modell derselben Familie |
| `draft-eagle3`, `draft-dflash`, `draft-dspark` | Ein eigens konvertierter Checkpoint zu genau diesem Zielmodell; dspark unterstützt derzeit nur Qwen3-Backbones |

Das Draft-Modell muss im Modellverzeichnis liegen, dann steht es in der
Auswahl. **Entwürfe pro Schritt** ist `--spec-draft-n-max`, llama.cpp-Default 3;
für die MTP-Köpfe empfiehlt Unsloth 2.

Die n-Gram-Strategien von llama.cpp brauchen kein zweites Modell, stehen hier
aber nicht zur Wahl — dafür bleibt `--extra-args` offen.

## Media API

Die [Media API](../toolboxes_media_api/README.md) — Qwen-Image-2512,
Qwen-Image-Edit-2511 und MiniMax-H3 hinter einer API mit Schlüssel und einem
Playground — wird hier verwaltet wie die anderen Container, nicht nur verlinkt.
Die Seite **Media API** hat alles, was nur dieser Dienst hat; Starten, Stoppen,
Neustart, Entfernen, Logs und Gesundheit laufen über dieselben Wege wie bei
jedem llama-server, und der Container steht auch unter **Server**.

- **Einstellungen**, eine Konfiguration pro Box
  (`~/.config/strix-halo-webui/media-api.json`): Name, Image, Host-Port und
  Bind-Adresse, Modell- und Datenverzeichnis, Backend (`real` mit GPU oder `mock`
  ohne), die ausdrückliche Rootful-Appliance-Freigabe (standardmäßig aus), Download-Regel,
  Speicherprüfung, Cookie-, CORS- und Sitzungsoptionen,
  die Grenzen des Dienstes (leer = dessen Standard) und Autostart. Gespeichert
  wird erst einmal nur; **Neu anlegen** bringt eine Änderung in den laufenden
  Container. Bis dahin sagt die Seite, dass er mit alten Einstellungen läuft —
  der Container trägt einen Hash seines vollständigen Aufrufs als Label.
- **Der Aufruf** ist der gehärtete aus der README der Media API, Flag für Flag:
  standardmäßig rootless mit `--userns=keep-id`, `--cap-drop=all`,
  `--security-opt=no-new-privileges`, Modelle schreibgeschützt, der Port nur auf
  `127.0.0.1`. Das Mock-Backend bekommt weder GPU noch `seccomp=unconfined`. Ob
  Podman rootless läuft, fragt das Webinterface Podman selbst (`podman info`). Rootful
  ist nur mit `allowRootfulPodman`, WebUI-UID 0 und der eindeutigen Antwort
  `rootless=false`, `serviceIsRemote=false` erlaubt; dann entfallen `keep-id` und `keep-groups`, alle anderen
  Härtungen bleiben. Unbekannt bleibt gesperrt. Rootful über `CONTAINER_HOST`,
  `CONTAINER_CONNECTION` oder eine in `containers.conf` ausgewählte Remote-Verbindung bleibt ebenfalls gesperrt, weil lokale root-eigene Mounts
  bei einem entfernten oder mehrdeutigen Daemon nicht beweisbar sind. Das reale Backend braucht für ROCm weiterhin
  `seccomp=unconfined` — ein Restrisiko, das die README der Media API beschreibt,
  kein gelöstes Problem. Auch hier gilt die Image-Beschränkung auf dieses
  Repository, solange „Beliebige Images“ in den Einstellungen aus ist. Ältere
  Podman-Versionen ohne `Host.ServiceIsRemote` bleiben rootless nutzbar, können
  aber die positive Lokalitätsprüfung für rootful nicht erfüllen.
- **Schlüssel.** API-Schlüssel und Sitzungsgeheimnis erzeugt das Webinterface
  selbst, als 0600-Dateien in `~/.config/strix-halo-webui/media-api/` (0700). Sie
  werden einzeln schreibgeschützt eingehängt und über `MEDIA_API_KEY_FILE` bzw.
  `MEDIA_SESSION_SECRET_FILE` gelesen — kein Wert steht je in einem Argv, einem
  Label oder in `podman inspect`. Die Oberfläche zeigt nur einen Fingerabdruck
  — ein HMAC mit einem lokalen Zufallsschlüssel, kein bloßer Hash, gegen den sich
  ein schwacher eigener Schlüssel offline durchprobieren ließe —,
  auch dem Besitzer: Den Schlüssel liest man auf der Box mit `cat`, oder man setzt
  einen eigenen, den die Clients schon kennen. Neu erzeugen und Setzen gehen nur
  in einer Browser-Sitzung, nie mit dem MCP-Token. Der Dienst liest Schlüssel
  beim Start; die Seite meldet, wenn er noch den alten hat, und fragt ihn dann
  auch nicht mit dem neuen an — das würde nur seine Sperre für Fehlversuche
  füttern, die sich die Playground-Nutzer auf dieser Box mit dem Webinterface
  teilen.
- **Modelle.** Welche Modelle und Profile es gibt, weiß das Image selbst: Die
  Übersicht ruft `media-api-models check --json` auf — im laufenden Container per
  `podman exec`, sonst in einem Wegwerf-Container ohne Netz, ohne GPU und ohne
  Schlüssel. Sie zeigt je Profil Speicherbedarf, Aufgaben, was fehlt (auch je
  Aufgabe) und bei nicht unterstützten Formaten den Grund. **Laden** startet
  `media-api-models fetch --json` in einem Wegwerf-Container, dem einzigen mit
  beschreibbarem Modellbaum; der Dienst behält seinen schreibgeschützten Mount
  und sieht neue Dateien ohne Neustart. Fortschritt, Abbrechen und Fortsetzen
  laufen über dieselbe Download-Liste wie bei den GGUFs; es läuft immer nur einer,
  auf einer eigenen Warteschlange, und jeder in einem Container mit eigenem Namen.
  Der HF-Token geht als 0600-Datei nur dieses Jobs hinein, schreibgeschützt
  gemountet und über `HF_TOKEN_PATH` gelesen — nie als Wert in einer Umgebung,
  also auch nicht in `podman inspect` —, und wird mit dem Ende des Jobs gelöscht,
  auch bei Abbruch. Die Übersicht und „Laden“ beziehen sich immer auf die
  *gespeicherten* Einstellungen; läuft der Container noch mit einem anderen Image
  oder Modellbaum, sagt die Seite das dazu.
- **Platz.** Vor dem Download prüft `media-api-models fetch` die Größen beim Hub:
  frei sein müssen die Dateien, die Reserve des Dienstes
  (`MEDIA_MIN_FREE_DISK_BYTES`, 1 GiB) und Luft für Teildateien, Staging und
  Xet-Cache (2 %, mindestens 1 GiB). Während des Downloads bricht ein Wächter ab,
  sobald der freie Platz unter die Reserve fällt; Teildateien bleiben für
  „Fortsetzen“. Nur dieser Wächter macht Einträge ohne bekannte Größe zulässig —
  der Dienst selbst (`MEDIA_ALLOW_DOWNLOADS`) hat keinen und lädt sie nicht.
- **Modellbaum.** Standard ist der ComfyUI-Baum: Die Media API liest dessen
  Layout direkt und benutzt vorhandene FP8-Dateien mit. Ihre eigenen Ordner dort
  (`diffusers/`, `huggingface/`) stehen auf der ComfyUI-Seite als „Media API“
  statt als „unbekannt“.
- **Playground.** Der Link entsteht aus den eigenen Einstellungen, nie aus einer
  Anfrage, und trägt keinen Schlüssel — der Playground hat sein eigenes
  Anmeldeformular. Bei der Standardbindung an `127.0.0.1` ist er nur auf der Box
  selbst erreichbar; von anderswo nennt die Seite den SSH-Tunnel. Für Zugriff im
  Netz gehört ein TLS-Reverse-Proxy davor, dessen Adresse als „öffentliche URL“
  eingetragen wird, dazu „Cookie nur über HTTPS“.
- **Downloads durch den Dienst selbst** (`MEDIA_ALLOW_DOWNLOADS`) lassen sich
  einschalten, verlangen dann aber einen beschreibbaren Modell-Mount und werden
  mit einer Warnung quittiert; der HF-Token kommt dann ebenfalls als
  schreibgeschützte Datei (`HF_TOKEN_PATH`). Wird der Token in den Einstellungen
  geändert oder entfernt, schreibt das Webinterface dieselbe Datei sofort neu bzw.
  leert sie — ein laufender Dienst hat den alten Token also nicht mehr; „Neu
  anlegen“ entfernt danach auch den Mount.

Verzeichnisse, die den Container an Zugangsdaten ließen — das Home-Verzeichnis
selbst, `~/.ssh`, `~/.config`, die Konfiguration dieses Webinterfaces,
Podmans Speicher und Socket (`/run/user`), Systemverzeichnisse —, werden als
Modell- oder Datenverzeichnis abgelehnt, und zwar am aufgelösten Pfad: Ein
symbolischer Link irgendwo im Pfad wird nicht verfolgt, sondern abgelehnt. Die
einzige Ausnahme sind Links, die root in einem nur für root beschreibbaren
Verzeichnis angelegt hat — das Systemlayout, etwa `/home` → `/var/home` auf Fedora
Atomic und Bazzite. Kein Verzeichnis auf dem Pfad darf für andere als
den Benutzer und root beschreibbar sein (ausgenommen Sticky-Verzeichnisse wie
`/tmp`), sonst könnte ein fremder Prozess ihn austauschen. Gemountet wird der
kanonische Pfad, und zwar in drei Schritten: `podman create`, dann Abgleich jeder
Bind-Quelle mit dem geprüften Verzeichnis (Pfad, Gerät und Inode), erst dann
`podman start` — beim Dienst wie bei Modellübersicht und Download. Ein unterwegs
ausgetauschtes Verzeichnis bricht ab, der Container wird entfernt, ohne gelaufen
zu sein. Start, Neustart und Autostart eines Media-Containers laufen jedes Mal
durch dieselbe fail-closed Laufzeitprüfung. Solange „Beliebige Images“ aus ist, bekommt nur das
Media-API-Image dieses Repositorys Modellbaum, Netz oder Token — beim Speichern,
Anlegen, Prüfen und Laden.

## Netzwerk und Firewall

Die Seite **Netzwerk** führt beides zusammen: alle Schnittstellen der Box mit
Adressen, Linkgeschwindigkeit, MAC und MTU — und darunter die Ports, die durch
die Firewall müssen. Je Port zwei Wege: **für alle freigeben** oder **nur für
eine Quelle**, also für eine IP-Adresse oder ein Subnetz. Der zweite Weg legt
eine Rich Rule an, genau in dieser Form:

```
rule family="ipv4" source address="10.7.7.0/24" port port="50052" protocol="tcp" accept
```

Bestehende Regeln dieser Form werden gelesen und in der Portzeile angezeigt —
ein Port, der nur für das Cluster-Subnetz offen ist, steht dort als **„nur für
Quelle“** und nicht als „gesperrt“. Alles, was firewalld sonst noch kann
(Services, `log`, `reject`, Weiterleitungen), wird unverändert angezeigt, aber
nicht angefasst: Eine Regel, deren Wirkung die Anwendung nicht vollständig
beschreiben kann, entfernt sie auch nicht.

Welche Ports das sind, wird nicht gepflegt, sondern hergeleitet: der eigene Port
aus den Einstellungen, dazu je ein Port pro llama-server und pro RPC-Worker. Ein
Server, der vor fünf Minuten gestartet wurde, steht dort ohne weiteres Zutun,
und ein Port, der für einen längst gelöschten Server offen ist, fällt auf.

Fedora bringt firewalld mit, und dessen Standardzonen lassen keinen der hier
relevanten Ports durch. Je nachdem, was auf der Maschine läuft, sind es bis zu
drei:

| Port | Wofür | Geschützt durch |
|---|---|---|
| 8420 | das Webinterface selbst | Passwort + JWT-Cookie |
| 11434 | llama-server (Default je Server) | `--api-key` |
| 8100 | Media API — standardmäßig nur an `127.0.0.1` gebunden | API-Schlüssel, Playground mit Sitzung + CSRF |
| 50052 | RPC-Worker (`ggml-rpc-server`) | **nichts** |

Zwei Dinge macht die Oberfläche bewusst nicht:

- **Kein `firewall-cmd --reload`.** Ein Reload reißt podmans eigene
  Weiterleitungsregeln mit, und laufende Container sind danach nicht mehr
  erreichbar, obwohl sie laufen. Stattdessen wird jede Änderung zweimal
  angewandt — einmal für die laufende Firewall, einmal dauerhaft. Gleiches
  Ergebnis, kein Reload. (Wer doch einmal reloadet und danach einen Container
  nicht erreicht: Container neu starten.)
- **Keine fremden Regeln anfassen.** Ports, die zu keinem verwalteten Dienst
  gehören — SSH etwa —, werden angezeigt, aber nicht angeboten. Ein Knopf, der
  Port 22 schließen kann, ist ein Knopf, der die eigene Sitzung beendet.

Läuft das Webinterface **nicht als root**, verweigert polkit den Zugriff auf
firewalld. Dann zeigt die Seite denselben Stand, nur mit den Befehlen statt der
Schalter:

```bash
sudo firewall-cmd --add-port=11434/tcp              # sofort
sudo firewall-cmd --permanent --add-port=11434/tcp  # und nach dem Neustart
sudo firewall-cmd --list-ports
```

Für das Webinterface selbst erledigt das schon der Installer mit
`--open-firewall`. Ein zweiter Server auf einem anderen Port braucht dessen Port
zusätzlich — 11435, 11436 und so weiter.

Adressen vergibt die Oberfläche nicht. Eine Schnittstelle umzukonfigurieren,
während die Seite über genau diese Schnittstelle ausgeliefert wird, ist der
kürzeste Weg zu einer Box, die Tastatur und Monitor braucht — der `nmcli`-Befehl
dafür steht [weiter unten](#übersicht).

### Der RPC-Port ist ein Sonderfall

`ggml-rpc-server` kennt **keine Authentifizierung** — llama.cpp warnt beim Start
selbst in Großbuchstaben davor. Wer Port 50052 erreicht, kann auf der GPU dieser
Maschine rechnen lassen und ihren Speicher belegen. Deshalb nicht pauschal
aufmachen, sondern nur für die Adressen, die ihn wirklich brauchen, also den
Master des Clusters.

Genau dafür ist auf der Netzwerkseite **„Nur für Quelle“** da: Port 50052 steht
dort auch dann, wenn gerade kein Worker läuft — die Freigabe richtet man
üblicherweise ein, bevor der Worker das erste Mal startet. Von Hand:

```bash
sudo firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="192.168.100.0/24" port port="50052" protocol="tcp" accept'
sudo firewall-cmd --reload
sudo firewall-cmd --list-all
```

Das Subnetz durch das eigene ersetzen. Wer strenger sein will, gibt statt des
Netzes die einzelne Adresse des Masters an (`source address="192.168.100.10/32"`).
Bei USB4-Direktverbindungen ist jede Strecke ein eigenes kleines Subnetz — dann
pro Strecke eine Regel.

Fehlt die Freigabe, sieht das Symptom nach einem Anwendungsfehler aus, ist aber
keiner: der Master meldet den Knoten beim Preflight als nicht erreichbar
(Zeitüberschreitung), und im Log des Workers steht dazu **nichts** — die Pakete
kommen dort nie an. Ein Worker, dessen Port offen ist, protokolliert jeden
Verbindungsversuch.

## Übersicht

Die Startseite zeigt live, was die Box gerade tut: GPU-Auslastung, GTT- und
VRAM-Belegung, Temperatur, CPU, Arbeitsspeicher, freier Plattenplatz, Laufzeit
und die laufenden Server mit ihren Container-Werten. Alle Kacheln führen zehn
Minuten Verlauf mit.

Darunter steht eine Tabelle mit **jeder Netzwerkschnittstelle**, die der Kernel
kennt, mit ihrer IP-Adresse samt Präfix, dem aktuellen Durchsatz je Richtung,
den Zählern seit dem Systemstart und einem Verlauf des Gesamtdurchsatzes.
Adressen, die niemand vergeben hat (`fe80::`, `169.254.`), stehen nicht als
gleichwertig daneben, sondern als **„nur Link-Local, nicht konfiguriert“** — das
ist der Normalzustand eines frisch eingesteckten USB4-Kabels und etwas anderes
als „keine IP“. Die Liste ist nirgends fest verdrahtet:

- Steckt ein USB4- oder Thunderbolt-Kabel zu einer zweiten Strix-Halo-Box, taucht
  die neue Schnittstelle (meist `thunderbolt0`) beim nächsten Tick von selbst auf
  — mit Kennzeichnung **USB4/TB** und der ausgehandelten Linkgeschwindigkeit. Für
  verteilte Inferenz über llama.cpp-RPC ist das die Stelle, an der man sieht, ob
  der schnelle Link überhaupt benutzt wird.
- Die Rate eines solchen Links kommt nicht aus `/sys/class/net/<if>/speed` —
  `thunderbolt-net` beantwortet diese Abfrage nicht —, sondern vom
  Thunderbolt-Gerät selbst, samt Anzahl der Lanes. Zwei Lanes à 20 Gbit/s
  ergeben die 40 Gbit/s, für die das Kabel verkauft wurde; steht dort nur
  **1 Lane**, hat die Verbindung die Hälfte ausgehandelt, und das liegt fast
  immer am Kabel oder am Port.
- Eine IP bekommt so ein Link von niemandem geschenkt. Steht in der Zeile „nur
  Link-Local“, fehlt sie noch — auf beiden Maschinen je einmal setzen, dann
  laufen RPC-Verbindungen darüber:

  ```bash
  # Box A; auf Box B dasselbe mit .12
  nmcli con add type ethernet ifname thunderbolt0 con-name tb0 \
    ip4 192.168.100.11/24
  nmcli con up tb0
  ```

- Die Einordnung kommt aus sysfs (an welchem Bus die Karte hängt), nicht aus dem
  Namen — ein USB4-Adapter, den der Kernel `eno2` nennt, wird trotzdem als solcher
  erkannt.
- Virtuelle Schnittstellen (Container-Bridges, `veth`-Paare, VPNs) stehen hinter
  einem Schalter, damit sie die physischen Links nicht verdrängen.
- Zählt eine Schnittstelle Fehler, steht das rot in ihrer Zeile — bei USB4 meist
  ein Kabel- oder Steckproblem.

Auf einem Rechner ohne `/proc/net/dev` (etwa einem Mac zur Entwicklung) entfällt
der Abschnitt ersatzlos, wie die GPU-Kacheln auch.

## MCP-Server

Unter `http://<box>:8420/mcp` spricht die Webapp das
[Model Context Protocol](https://modelcontextprotocol.io). Ein Agent wie
Claude Desktop, Claude Code oder Hermes Agent kann die Box damit genauso steuern
wie diese Oberfläche: Server, RPC-Worker, ComfyUI und die Media API starten und stoppen, Logs
lesen, Modelle suchen, laden, schätzen und löschen, Profile pflegen, Images
ziehen, Firewall-Ports freigeben, Einstellungen ändern, Updates einspielen.
Jede Box ist ihr eigener MCP-Server — bei mehreren Boxen trägt man jede einzeln
ein.

**Einrichten:** *Einstellungen → MCP-Zugang → Token erzeugen.* Der Token
erscheint genau einmal, fertig eingesetzt in die Konfiguration für den
gewählten Client. Gespeichert wird nur sein SHA-256-Hash; wer ihn verliert,
erzeugt einen neuen, der den alten sofort ablöst.

Claude Desktop kennt für lokale Konfigurationen nur Prozesse über stdio, daher
übersetzt [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) (braucht
Node.js auf dem Rechner mit Claude Desktop):

```json
{
  "mcpServers": {
    "strix-halo": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://box:8420/mcp", "--allow-http",
               "--header", "Authorization:${SHX_AUTH}"],
      "env": { "SHX_AUTH": "Bearer shx_…" }
    }
  }
}
```

`--allow-http` ist nötig, weil die Box kein TLS spricht; der Header steht in
einer Umgebungsvariablen, weil Claude Desktop Argumente mit Leerzeichen nicht
zuverlässig weiterreicht.

Hermes Agent (`~/.hermes/config.yaml`) und Claude Code sprechen HTTP direkt:

```yaml
mcp_servers:
  strix-halo:
    url: "http://box:8420/mcp"
    headers:
      Authorization: "Bearer shx_…"
```

```bash
claude mcp add --transport http strix-halo http://box:8420/mcp \
  --header "Authorization: Bearer shx_…"
```

Wie es gebaut ist:

- **Jedes Tool ist ein Aufruf der REST-API**, die auch der Browser benutzt —
  per Loopback und mit dem Token des Aufrufers. Validierung und alle
  Ablehnungen („Modell wird von ‚qwen‘ benutzt“, „Port gehört zu keinem
  verwalteten Dienst“) gelten für einen Agenten also genauso wie für einen
  Klick. Die Tools ergänzen nur Bequemlichkeit: Standardwerte aus den
  Einstellungen, Profile per Name statt ID, `wait_for_job` für Downloads und
  `get_overview` als Einstieg.
- **Zustandslos, nur JSON.** Streamable HTTP ohne Session und ohne
  Server-Stream; `GET /mcp` beantwortet der Server mit 405, wie das Protokoll es
  erlaubt. Kein SDK — für vier JSON-RPC-Methoden hätte es Express, ajv und
  einen OAuth-Client ein zweites Mal mitgebracht.
- **Kein OAuth.** Der Token ist der einzige Zugang. Ein Client, der nach einer
  401 OAuth-Metadaten unter `/.well-known/` sucht, bekommt eine klare 404
  statt der Startseite.
- Tool-Beschreibungen und Fehlermeldungen sind deutsch, wie die Oberfläche.

## Betrieb

Als normaler Benutzer:

```bash
systemctl --user status  strix-halo-webui
systemctl --user restart strix-halo-webui
journalctl --user -u strix-halo-webui -f
```

Als root (System-Unit — ohne `--user`):

```bash
systemctl status  strix-halo-webui
systemctl restart strix-halo-webui
journalctl -u strix-halo-webui -f
```

Benutzername und Passwort ändern: in der Weboberfläche unter **Einstellungen →
Konto**. Beides braucht das aktuelle Passwort als Bestätigung; andere
angemeldete Sitzungen werden dabei abgemeldet.

Zugang verloren? Auf der Box:

```bash
webui/scripts/shx-passwd                      # Passwort interaktiv setzen
webui/scripts/shx-passwd --generate           # neues erzeugen und anzeigen
webui/scripts/shx-passwd --username steve     # nur umbenennen
webui/scripts/shx-passwd --username steve --generate   # beides
```

Neu starten geht auch aus der Oberfläche: **Einstellungen → Dienst → Dienst neu
starten**. Laufende Container bleiben davon unberührt; ein laufender Download
bricht ab und lässt sich danach fortsetzen.

Funktionsprüfung einer laufenden Instanz:

```bash
SHX_PASSWORD=… webui/scripts/smoke.sh http://box:8420
```

## Was wo liegt

| Pfad | Inhalt |
|---|---|
| `~/.config/strix-halo-webui/config.json` | Zugangsdaten, JWT-Secret, HF-Token, Einstellungen (0600) |
| `~/.config/strix-halo-webui/profiles.json` | Server-Profile inkl. API-Keys (0600) |
| `~/.config/strix-halo-webui/media-api.json` | Einstellungen der Media API (0600, ohne Geheimnisse) |
| `~/.config/strix-halo-webui/media-api/` | API-Schlüssel und Sitzungsgeheimnis der Media API als Dateien (0700/0600) |
| `~/media-api-data` (konfigurierbar) | Ergebnisse, Uploads und Aufträge der Media API |
| `~/.local/state/strix-halo-webui/state.json` | Job-Historie, Image-Digests, Feature-Cache |
| `~/.local/state/strix-halo-webui/app.log` | Anwendungslog, rotiert bei 5 MB |
| `~/models` (konfigurierbar) | die GGUF-Dateien |

Konfiguration und Zustand liegen **außerhalb** des Repositories, damit ein
`git pull` beim Self-Update sie nicht anfassen kann.

## Sicherheit

Die App ist ein **Gerät für ein vertrauenswürdiges LAN**, kein internetfähiger
Dienst. Sie bringt kein TLS mit; für eine Veröffentlichung gehört ein
Reverse-Proxy davor und `--bind 127.0.0.1`.

Was sie tut:

- Ein Admin-Konto, Passwort per scrypt gehasht, JWT in einem
  httpOnly-Cookie (`SameSite=Strict`, 12 h).
- Eine Änderung von Benutzername oder Passwort beendet alle anderen Sitzungen
  sofort. Ohne das bliebe ein fremder Zugriff nach einem Passwortwechsel noch
  bis zu 12 Stunden bestehen — genau der Fall, für den man das Passwort
  wechselt.
- CSRF-Schutz dreifach: SameSite, Origin-Abgleich und ein Pflicht-Header
  `X-Requested-With`. CORS ist gar nicht erst aktiviert.
- Login-Drosselung: 5 Versuche je 15 Minuten und IP.
- Kein Shell-Aufruf, nirgends — alle Subprozesse laufen mit Argv-Arrays
  (per ESLint-Regel erzwungen).
- Modellpfade werden gegen Traversal *und* Symlink-Ausbrüche geprüft.
- Nur Images aus `docker.io/st3v0rr/amd-strix-halo-toolboxes` sind erlaubt;
  beliebige Referenzen lassen sich in den Einstellungen freischalten.
- HF-Token und API-Keys werden aus Logs, SSE-Streams und Fehlermeldungen
  entfernt — die Schlüssel der Media API ebenso; sie verlassen die Box nie über
  die API, nur als Fingerabdruck.
- Der MCP-Token (`Authorization: Bearer shx_…`) öffnet `/mcp` und die
  REST-API, nie aber Benutzername, Passwort, JWT-Secret oder den Token selbst —
  dafür braucht es eine angemeldete Browser-Sitzung. Ein Agent kann die Box also
  steuern, aber den Besitzer nicht aussperren und sich keinen Nachfolger
  ausstellen. Ein Passwortwechsel widerruft den Token **nicht**; das geht
  getrennt unter *Einstellungen → MCP-Zugang*.

Bekannter Vorbehalt: der API-Key eines Servers steht im Container-Argv und ist
über `podman inspect` für jeden Prozess desselben Benutzers sichtbar — genauso
wie bei `run-llama-server.sh`. Wer das vermeiden will, kann llama-server
stattdessen `--api-key-file` mit einer Datei im Models-Mount übergeben (über
das Feld „Zusätzliche Argumente").

## Wie das Starten funktioniert

Das Backend baut das `podman run`-Argv selbst, als exakte Portierung von
`run-llama-server.sh`. Dass beide identisch sind, wird nicht behauptet, sondern
geprüft:

```bash
npm run test:parity
```

Dabei läuft das **echte** Skript gegen ein Fake-podman, das nur seine Argumente
ausgibt, und das Ergebnis wird mit dem unseres Builders verglichen.

Für die Media API gibt es kein Skript; ihre Referenzen sind der gehärtete Aufruf
in `toolboxes_media_api/README.md` — `server/test/media-parity.test.js` liest
genau diesen Block und verlangt jedes Flag daraus, ohne unerwartete Zugaben —
und ihr eigener Konfigurationslader: `test:parity` füttert
`media_api.config.load_settings()` mit der Umgebung, die das Webinterface baut,
bis an die Grenzen jedes Limits. Ein Variablenname, den der Dienst nicht kennt,
fiele sonst nie auf; er ignoriert ihn einfach. Braucht ein Python mit PyYAML
(`toolboxes_media_api/.venv` oder `python3`), sonst wird dieser Teil sichtbar
übersprungen.

Zwei Eigenheiten aus dem Skript sind dabei besonders wichtig:

- Auf Strix Halo sind Flash Attention und kein mmap zwingend. Die Schreibweise
  hat sich geändert (`-fa 1 --no-mmap` → `-fa on --load-mode none`), deshalb
  wird sie am Image ermittelt. Bietet der Build `--lazy-mode on-direct`
  (`rocm-10.0-strix-llama`), kommt das dazu. Das Ergebnis wird pro
  **Image-ID** zwischengespeichert — nach einem Pull erkennt die App
  automatisch neu.
- Fehlt die Modelldatei, wird der Start verweigert. Sonst bricht llama-server
  ab und `--restart unless-stopped` erzeugt eine stille Neustart-Schleife.
  Für den Vision-Projektor gilt dasselbe, aus einem schlimmeren Grund: ein
  fehlender Projektor stoppt den Server nicht, er lässt nur jede Bildanfrage
  scheitern — ohne dass im Log etwas auf die Ursache zeigt.

Container werden mit `shx.*`-Labels markiert. Damit erkennt die App ihre
eigenen wieder — auch nach einem Reboot oder einem gelöschten `state.json` —
und lässt von Hand gestartete Container in Ruhe.

### Aus einem laufenden Server ein Profil machen

Auf der Serverdetailseite legt **Als Profil speichern** den Profil-Dialog mit
den Werten des Containers an — Modell, Projektor, Image,
Context, GPU-Layers, Threads, Port, Zusatzargumente und RPC-Knoten. Gespeichert
wird erst, wenn du im Dialog auf Speichern gehst; Name und Autostart setzt du
dort noch selbst.

Der API-Key wird mit übernommen, damit ein Start aus dem Profil denselben Key
hat wie der laufende Server und Clients nichts umstellen müssen. Er steht
bewusst nicht in den Labels — dort könnte ihn jeder Prozess dieses Benutzers
lesen — sondern wird aus der Kommandozeile des Containers gelesen, also aus
derselben Quelle, die die Detailseite ohnehin anzeigt.

**Autostart** wird nie übernommen: dass ein Container gerade läuft, sagt nichts
darüber, ob du ihn nach einem Reboot zurück haben willst.

RPC-Worker haben keine Profil-Einstellungen; dort fehlt der Knopf.

## Autostart

Rootless-Container kommen beim Boot **nicht** von selbst zurück. Statt
`podman-restart.service` zu aktivieren (was zu Doppelstarts führt), gleicht die
App 15 Sekunden nach ihrem eigenen Start alle Profile mit `autostart` ab:

- Container läuft → nichts tun
- Container existiert, gestoppt → starten
- Container fehlt → neu anlegen

Nacheinander mit 5 Sekunden Abstand, weil zwei gleichzeitig ladende große
Modelle den Unified Memory zerlegen. Das Ergebnis steht auf der Übersichtsseite;
ein fehlgeschlagener Autostart ist also nicht still.

## Self-Update

Die Updates-Seite zeigt neue Commits des getrackten Branches und wendet sie an:
`git pull --ff-only` → ggf. `npm ci` → ggf. `npm run build` → Dienst neu starten.

Bei lokalen Änderungen wird das Update **abgelehnt** — auf der Box wird an den
Skripten gearbeitet, und ein Update darf das nicht überfahren.

Der Updater läuft über `systemd-run` in einer eigenen transienten Unit (mit
`--user`, wenn der Dienst als User-Unit läuft). Ein normales Kind läge in der
cgroup unseres Dienstes und würde vom abschließenden `systemctl restart` mitten
im `npm ci` erschlagen. Die Betriebsart reicht die Unit über
`SHX_SYSTEMD_SCOPE` durch.

## Entwicklung

Ohne podman, ohne GPU, auf einem beliebigen Rechner:

```bash
npm install
npm run dev      # API auf 8420 (Mock), Vite auf 5173, Zugang admin/devdev
```

Der Mock-Modus ist ein Konfigurationstausch, kein Code-Zweig: jeder externe
Prozess läuft über `server/src/lib/exec.js`, und `dev/bin/podman` bzw.
`dev/bin/hf` sind echte ausführbare Attrappen, die aufgezeichnete Ausgaben
abspielen — inklusive Carriage-Return-Fortschritt und wachsender
`.incomplete`-Dateien. Damit werden die echten Streaming- und Parser-Pfade
getestet, nicht Umgehungen davon.

```bash
npm test           # Unit- und Routentests (node --test), auch web/test
npm run test:parity  # Argv-Vergleich gegen run-llama-server.sh, Media-API-Umgebung gegen config.py
npm run lint
npm run build
```

Beide Zweige der fa/mmap-Erkennung lassen sich umschalten:

```bash
SHX_MOCK_HELP_VARIANT=old npm run dev
```

## Aufbau

```
webui/
  server/src/
    auth/      scrypt-Passwörter, JWT, Middleware
    config/    XDG-Pfade, zod-Schemata, atomarer JSON-Store
    lib/       exec (Subprozesse), sse, jobs, ansi, redact, ringbuffer
    podman/    argv, labels, features, client, servers, logstream, autostart
    models/    scan, paths (Traversal-Schutz), estimator, hfapi, download
    media/     Media API: Einstellungen, Schlüsseldateien, Modellübersicht, Downloads, Status
    images/    catalog, registry, pullparse, service
    system/    amdgpu, host, network, firewall, monitor
    updates/   git, apply
    mcp/       MCP-Endpunkt: Protokoll, Tools, Loopback zur REST-API
    routes/    die REST-API
  web/src/     React + Vite
  shared/      Konstanten, Quant-Gruppierung, RPC-Peers, Firewall-Regeln
  dev/         Mock-Attrappen, Fixtures, Parity-Harness
  scripts/     self-update.sh, smoke.sh, shx-passwd
```

Bewusst **keine nativen npm-Module**. `npm ci` muss auf der Box nach jedem
Node-Upgrade durchlaufen — sonst wäre ausgerechnet das Self-Update die
Bruchstelle. Deshalb scrypt statt bcrypt und JSON-Dateien statt SQLite.
