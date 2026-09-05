# Herkunft der Dateien in diesem Verzeichnis

`Dockerfile.comfyui`, `scripts/` und `workflows/` stammen aus

> **[kyuz0/amd-strix-halo-comfyui-toolboxes](https://github.com/kyuz0/amd-strix-halo-comfyui-toolboxes)**
> Revision `7e77f04c2926153fdb7265752192a1029503149f`

und sind hier als Kopie abgelegt, damit dieser Fork sein ComfyUI-Image ohne
fremdes Repository bauen kann. Wird das Original gelöscht oder umgezogen, baut
`build.sh` weiter.

`Dockerfile.comfyui` ist die einzige veränderte Datei: dort ersetzt der
abschließende `CMD` upstreams `CMD ["/bin/bash"]` durch einen Serverstart. Der
Kopfkommentar dort beschreibt es genauer. `scripts/` und `workflows/` sind
unverändert.

## Wieviel Unabhängigkeit das bringt

Nur die vom *Toolbox-Repo*. Der Build lädt weiterhin aus dem Netz:

| Quelle | Wofür |
| :--- | :--- |
| `registry.fedoraproject.org/fedora:rawhide` | Basis-Image |
| `rocm.nightlies.amd.com` | ROCm-Torch für gfx1151 |
| PyPI | ComfyUIs Abhängigkeiten |
| `github.com/comfyanonymous/ComfyUI` | ComfyUI selbst |
| `github.com/cubiq/ComfyUI_essentials` | Plugin |
| `github.com/kyuz0/ComfyUI-AMDGPUMonitor` | Plugin (GPU-Overlay) |
| `github.com/kyuz0/ComfyUI-GGUF-H3` | Plugin, von 4 Workflows benutzt |
| `github.com/Larryvrh/ComfyUI-MiniMax-H3-Turbo` | Plugin, von 10 Workflows benutzt |

Ein Build ohne Netz ist das also nicht — aber der Ausfall *eines* Repos legt ihn
nicht mehr lahm, und die Skripte, auf denen die Modell-Downloads der webui
aufsetzen, liegen hier.

## Auf einen neueren Stand bringen

```bash
./sync-upstream.sh          # holt main, zeigt Unterschiede, fragt nach
./sync-upstream.sh <commit> # eine bestimmte Revision
```

Das Skript lässt `Dockerfile.comfyui` in Ruhe und meldet stattdessen, wenn sich
upstreams Dockerfile geändert hat — dann gehört die Änderung von Hand
übernommen, weil unser CMD-Block sonst verloren ginge.

Die Prüfung `check-upstream-comfyui.yaml` macht dasselbe täglich und meldet
Abweichungen, ohne etwas zu ändern.

## Lizenz

Das Ursprungsrepository führt keine Lizenzdatei. Die Dateien liegen hier
unverändert und mit Herkunftsangabe; wer sie weiterverwenden will, klärt die
Bedingungen mit dem Urheber.
