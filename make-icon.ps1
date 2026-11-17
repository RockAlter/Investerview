# Draws the InvestorView logo (the same shapes as public/icon.svg) and writes
#   public/icon.png  (256 px, the page and window icon)
#   icon.ico         (16-256 px, embedded in the exe by build-exe.js)
# Run:  powershell -ExecutionPolicy Bypass -File make-icon.ps1
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

function New-Logo([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.PixelOffsetMode = 'HighQuality'
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.ScaleTransform($size / 256.0, $size / 256.0)
  # rounded square with the blue-to-teal gradient
  $r = 56; $d = 2 * $r
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc(0, 0, $d, $d, 180, 90); $path.AddArc(256 - $d, 0, $d, $d, 270, 90)
  $path.AddArc(256 - $d, 256 - $d, $d, $d, 0, 90); $path.AddArc(0, 256 - $d, $d, $d, 90, 90); $path.CloseFigure()
  $c1 = [System.Drawing.ColorTranslator]::FromHtml('#2f6bff'); $c2 = [System.Drawing.ColorTranslator]::FromHtml('#0fb5a6')
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush((New-Object System.Drawing.PointF(0, 0)), (New-Object System.Drawing.PointF(256, 256)), $c1, $c2)
  $g.FillPath($brush, $path)
  $white = [System.Drawing.Color]::White
  # candlestick: wick and body (thicker wick at small sizes so it survives)
  $wick = New-Object System.Drawing.Pen($white, $(if ($size -le 32) { 16 } else { 10 })); $wick.StartCap = 'Round'; $wick.EndCap = 'Round'
  $g.DrawLine($wick, 74, 58, 74, 198)
  $body = New-Object System.Drawing.Drawing2D.GraphicsPath
  $bx = 54; $by = 92; $bw = 40; $bh = 76; $br = 16
  $body.AddArc($bx, $by, $br, $br, 180, 90); $body.AddArc($bx + $bw - $br, $by, $br, $br, 270, 90)
  $body.AddArc($bx + $bw - $br, $by + $bh - $br, $br, $br, 0, 90); $body.AddArc($bx, $by + $bh - $br, $br, $br, 90, 90); $body.CloseFigure()
  $g.FillPath((New-Object System.Drawing.SolidBrush($white)), $body)
  # the rising check line
  $pen = New-Object System.Drawing.Pen($white, 24); $pen.StartCap = 'Round'; $pen.EndCap = 'Round'; $pen.LineJoin = 'Round'
  $pts = [System.Drawing.PointF[]]@((New-Object System.Drawing.PointF(120, 96)), (New-Object System.Drawing.PointF(160, 178)), (New-Object System.Drawing.PointF(206, 74)))
  $g.DrawLines($pen, $pts)
  # marker on the latest price
  $g.FillEllipse((New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#ffd166'))), 191, 59, 30, 30)
  $g.Dispose()
  return $bmp
}
function Get-Png($bmp) { $ms = New-Object System.IO.MemoryStream; $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); return ,$ms.ToArray() }

$big = New-Logo 256
[System.IO.File]::WriteAllBytes((Join-Path $root 'public\icon.png'), (Get-Png $big))

# .ico made of PNG images (Windows Vista and later)
$sizes = 16, 24, 32, 48, 64, 128, 256
$pngs = foreach ($s in $sizes) { , (Get-Png (New-Logo $s)) }
$ms = New-Object System.IO.MemoryStream; $w = New-Object System.IO.BinaryWriter($ms)
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]; $len = $pngs[$i].Length
  $w.Write([byte]($s % 256)); $w.Write([byte]($s % 256)); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$len); $w.Write([uint32]$offset)
  $offset += $len
}
foreach ($p in $pngs) { $w.Write($p) }
$w.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $root 'icon.ico'), $ms.ToArray())
"wrote public\icon.png and icon.ico ($($ms.Length) bytes, sizes: $($sizes -join ', '))"
