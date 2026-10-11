# Copies the files that make up a release into a clean folder (default: ../neon-quill-3d-rel).
# Personal and generated things stay behind: cache, downloaded fonts, config.json, user-fonts.json,
# scratch files, developer notes. Fails if a machine-specific path slipped into a released file.
#   powershell -File tools/make-release.ps1 [-Out <folder>]
param([string]$Out = (Join-Path $PSScriptRoot '..\..\neon-quill-3d-rel'))

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Out = [System.IO.Path]::GetFullPath($Out)
if ($Out.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'The release folder must be outside the project folder.' }

# Reference bitmaps made from installed (commercial) fonts must not be shipped.
if ((Get-Content (Join-Path $root 'lib\ref-glyphs.json') -Raw) -notmatch '"origin":"open"') { throw 'lib/ref-glyphs.json was not made from the open fonts: run node tools/make-ref.js (online) first.' }

$items = 'server.js', 'package.json', 'package-lock.json', 'README.md', 'LICENSE', '.gitignore', 'lib', 'public', 'tools', 'fonts-bundled'
New-Item -ItemType Directory -Force $Out | Out-Null
foreach ($item in $items) {
  $dst = Join-Path $Out $item
  $src = Join-Path $root $item
  if (Test-Path $src -PathType Container) {
    # empty and refill the folder (it may be open elsewhere, and must not nest inside itself)
    New-Item -ItemType Directory -Force $dst | Out-Null
    Get-ChildItem $dst -Force | Remove-Item -Recurse -Force -Confirm:$false
    Copy-Item (Join-Path $src '*') $dst -Recurse -Force
  } else {
    Copy-Item $src $dst -Force
  }
}

# Nothing released may point at a drive or user folder of the machine it was made on.
# (%WINDIR%'s documented default is the one accepted exception.)
$bad = Get-ChildItem $Out -Recurse -File -Exclude *.ttf, *.otf |
  Where-Object { $_.FullName -notmatch '\\node_modules\\|\\cache\\' -and $_.Name -ne 'make-release.ps1' } |
  Select-String -Pattern '\b[A-Za-z]:[\\/]{1,2}(?!Windows\b)\w', '\\Users\\\w', 'file:///' |
  Where-Object { $_.Line -notmatch 'https?://' -or $_.Line -match '\b[A-Za-z]:\\' }
if ($bad) {
  $bad | ForEach-Object { Write-Host ("{0}:{1}: {2}" -f $_.Path.Substring($Out.Length + 1), $_.LineNumber, $_.Line.Trim()) }
  throw 'Machine-specific paths found in the release (listed above).'
}
$files = Get-ChildItem $Out -Recurse -File | Where-Object { $_.FullName -notmatch '\\node_modules\\|\\cache\\' }
Write-Host ("Release written to {0}: {1} files, {2:N1} MB" -f $Out, $files.Count, (($files | Measure-Object Length -Sum).Sum / 1MB))
