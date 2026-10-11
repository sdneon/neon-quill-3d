# Renders the given characters in every installed font (each available style) as small bitmaps
# stretched to the glyph's bounding box. Used by lib/find.js to name the font of a sample STL.
#   render-fonts.ps1 -Codes 83,77 -Size 32 -Out file.json
param([Parameter(Mandatory)][int[]]$Codes, [int]$Size = 32, [Parameter(Mandatory)][string]$Out)

Add-Type -AssemblyName System.Drawing
$fmt = [System.Drawing.StringFormat]::GenericTypographic
$em = 300.0
$styles = @('Regular', 'Bold', 'Italic', 'Bold, Italic')
$fonts = New-Object System.Collections.Generic.List[object]
$rect = New-Object System.Drawing.Rectangle 0, 0, $Size, $Size
$raw = New-Object byte[] ($Size * $Size * 4)

Add-Type -Namespace Native -Name Gdi -MemberDefinition @'
[DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hdc, IntPtr h);
[DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr h);
[DllImport("gdi32.dll", CharSet = CharSet.Unicode)] public static extern uint GetGlyphIndicesW(IntPtr hdc, string s, int c, [Out] ushort[] pgi, uint fl);
'@
$probe = New-Object System.Drawing.Bitmap 1, 1
$probeGfx = [System.Drawing.Graphics]::FromImage($probe)
$hdc = $probeGfx.GetHdc()
$codeText = -join ($Codes | ForEach-Object { [char]$_ })

foreach ($family in (New-Object System.Drawing.Text.InstalledFontCollection).Families) {
  foreach ($styleName in $styles) {
    $style = [System.Drawing.FontStyle]$styleName
    if (-not $family.IsStyleAvailable($style)) { continue }
    $glyphs = @()
    # Skip characters the font itself lacks (GDI+ would substitute another font's glyphs).
    $own = New-Object 'uint16[]' $Codes.Length
    $have = $false
    try {
      $gfont = New-Object System.Drawing.Font $family, 20, $style
      $hf = $gfont.ToHfont()
      $prev = [Native.Gdi]::SelectObject($hdc, $hf)
      $have = [Native.Gdi]::GetGlyphIndicesW($hdc, $codeText, $Codes.Length, $own, 1) -ne 0xFFFFFFFFL
      [void][Native.Gdi]::SelectObject($hdc, $prev)
      [void][Native.Gdi]::DeleteObject($hf)
      $gfont.Dispose()
    } catch { }
    if (-not $have) { continue }
    # Second guard: an outline identical to that of a never-assigned character is the "missing" box.
    $missing = ''
    $np = New-Object System.Drawing.Drawing2D.GraphicsPath
    try {
      $np.AddString([string][char]0xFFFE, $family, [int]$style, $em, (New-Object System.Drawing.PointF 0, 0), $fmt)
      $nb = $np.GetBounds()
      $missing = '{0}|{1:0.0}|{2:0.0}|{3:0.0}' -f $np.PointCount, $nb.Width, $nb.Height, $nb.Y
    } catch { }
    $np.Dispose()
    for ($ci = 0; $ci -lt $Codes.Length; $ci++) {
      $code = $Codes[$ci]
      if ($own[$ci] -eq 0xFFFF) { continue }
      $path = New-Object System.Drawing.Drawing2D.GraphicsPath
      try { $path.AddString([string][char]$code, $family, [int]$style, $em, (New-Object System.Drawing.PointF 0, 0), $fmt) } catch { $path.Dispose(); continue }
      $b = $path.GetBounds()
      if ($b.Width -le 0 -or $b.Height -le 0) { $path.Dispose(); continue }
      if (('{0}|{1:0.0}|{2:0.0}|{3:0.0}' -f $path.PointCount, $b.Width, $b.Height, $b.Y) -eq $missing) { $path.Dispose(); continue }
      $m = New-Object System.Drawing.Drawing2D.Matrix
      $m.Scale($Size / $b.Width, $Size / $b.Height)
      $m.Translate(-$b.X, -$b.Y)
      $path.Transform($m)
      $bmp = New-Object System.Drawing.Bitmap $Size, $Size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.SmoothingMode = 'AntiAlias'
      $g.Clear([System.Drawing.Color]::Black)
      $g.FillPath([System.Drawing.Brushes]::White, $path)
      $g.Dispose()
      $data = $bmp.LockBits($rect, 'ReadOnly', $bmp.PixelFormat)
      [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $raw, 0, $raw.Length)
      $bmp.UnlockBits($data)
      $bmp.Dispose(); $path.Dispose(); $m.Dispose()
      $gray = New-Object byte[] ($Size * $Size)
      for ($i = 0; $i -lt $gray.Length; $i++) { $gray[$i] = $raw[$i * 4 + 1] }
      $glyphs += [ordered]@{ c = $code; a = [math]::Round($b.Width / $b.Height, 4); m = [Convert]::ToBase64String($gray) }
    }
    if ($glyphs.Count) { $fonts.Add([ordered]@{ family = $family.Name; style = $styleName; glyphs = $glyphs }) }
  }
}

$json = [ordered]@{ size = $Size; fonts = $fonts } | ConvertTo-Json -Depth 6 -Compress
[System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding $false))
