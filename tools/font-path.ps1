# Prints the outline of some characters set in an installed font as SVG path data (JSON on stdout).
# Used for previews when no font file matches the exact face.
#   font-path.ps1 -Family "Cooper Black" -Style "Bold, Italic" -Codes 83,77
param([Parameter(Mandatory)][string]$Family, [string]$Style = 'Regular', [Parameter(Mandatory)][int[]]$Codes)

Add-Type -AssemblyName System.Drawing
$inv = [System.Globalization.CultureInfo]::InvariantCulture
$fam = New-Object System.Drawing.FontFamily $Family
$st = [System.Drawing.FontStyle]$Style
$text = -join ($Codes | ForEach-Object { [char]$_ })
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddString($text, $fam, [int]$st, 100.0, (New-Object System.Drawing.PointF 0, 0), [System.Drawing.StringFormat]::GenericTypographic)
$b = $path.GetBounds()
if ($path.PointCount -eq 0 -or $b.Width -le 0) { Write-Error 'nothing to draw'; exit 1 }
$pts = $path.PathPoints
$types = $path.PathTypes
$f = { param($p) $p.X.ToString('0.#', $inv) + ' ' + $p.Y.ToString('0.#', $inv) }
$sb = New-Object System.Text.StringBuilder
$i = 0
while ($i -lt $pts.Length) {
  $kind = $types[$i] -band 7
  if ($kind -eq 0) { [void]$sb.Append('M' + (& $f $pts[$i])); $last = $i; $i++ }
  elseif ($kind -eq 1) { [void]$sb.Append('L' + (& $f $pts[$i])); $last = $i; $i++ }
  else { [void]$sb.Append('C' + (& $f $pts[$i]) + ' ' + (& $f $pts[$i + 1]) + ' ' + (& $f $pts[$i + 2])); $last = $i + 2; $i += 3 }
  if ($types[$last] -band 0x80) { [void]$sb.Append('Z') }
}
$r = { param($v) [math]::Round($v, 1) }
[ordered]@{ d = $sb.ToString(); x = (& $r $b.X); y = (& $r $b.Y); w = (& $r $b.Width); h = (& $r $b.Height) } | ConvertTo-Json -Compress
