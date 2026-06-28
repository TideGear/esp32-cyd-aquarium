# Builds the Aquarium Clock APK without Gradle:
#   esbuild (jsrc -> assets/bundle.js) must already be run, then:
#   aapt2 compile/link -> javac -> d8 -> zipalign -> apksigner
# Requires: Android SDK build-tools + platform, a JDK 11+, and ~/.android/debug.keystore
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$sdk        = "$env:LOCALAPPDATA\Android\Sdk"
$buildTools = "$sdk\build-tools\35.0.0"
$androidJar = "$sdk\platforms\android-34\android.jar"
$jdk        = "C:\Program Files\Eclipse Adoptium\jdk-17.0.18.8-hotspot"
$keystore   = "$env:USERPROFILE\.android\debug.keystore"

$node = "C:\Program Files\nodejs"
$env:JAVA_HOME = $jdk
$env:Path = "$jdk\bin;$buildTools;$node;" +
    [Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
    [Environment]::GetEnvironmentVariable('Path','User')

$aapt2     = "$buildTools\aapt2.exe"
$d8        = "$buildTools\d8.bat"
$zipalign  = "$buildTools\zipalign.exe"
$apksigner = "$buildTools\apksigner.bat"

$build = "$PSScriptRoot\_build"
if (Test-Path $build) { Remove-Item $build -Recurse -Force }
New-Item -ItemType Directory -Path $build, "$build\gen", "$build\classes", "$build\dex" | Out-Null

Write-Host "==> esbuild bundle"
& "$PSScriptRoot\node_modules\.bin\esbuild.cmd" jsrc/app.js --bundle --format=iife --target=es2017 --minify --outfile=assets/bundle.js
if ($LASTEXITCODE -ne 0) { throw "esbuild failed" }

Write-Host "==> aapt2 compile resources"
& $aapt2 compile --dir res -o "$build\res.zip"
if ($LASTEXITCODE -ne 0) { throw "aapt2 compile failed" }

Write-Host "==> aapt2 link (resources + manifest + assets)"
& $aapt2 link -o "$build\base.apk" -I $androidJar --manifest AndroidManifest.xml `
    -A assets --java "$build\gen" --auto-add-overlay "$build\res.zip"
if ($LASTEXITCODE -ne 0) { throw "aapt2 link failed" }

Write-Host "==> javac"
$srcs = @(
  "java\com\aquarium\clock\MainActivity.java",
  "$build\gen\com\aquarium\clock\R.java"
)
& "$jdk\bin\javac.exe" --release 8 -classpath $androidJar -d "$build\classes" $srcs
if ($LASTEXITCODE -ne 0) { throw "javac failed" }

Write-Host "==> jar classes"
& "$jdk\bin\jar.exe" cf "$build\classes.jar" -C "$build\classes" .
if ($LASTEXITCODE -ne 0) { throw "jar failed" }

Write-Host "==> d8 (dex)"
& $d8 --min-api 21 --lib $androidJar --output "$build\dex" "$build\classes.jar"
if ($LASTEXITCODE -ne 0) { throw "d8 failed" }

Write-Host "==> add classes.dex into apk"
Copy-Item "$build\base.apk" "$build\unsigned.apk" -Force
Copy-Item "$build\dex\classes.dex" "$build\classes.dex" -Force
Push-Location $build
& "$jdk\bin\jar.exe" uf "unsigned.apk" "classes.dex"
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "jar uf (dex) failed" }
Pop-Location

Write-Host "==> zipalign"
& $zipalign -f -p 4 "$build\unsigned.apk" "$build\aligned.apk"
if ($LASTEXITCODE -ne 0) { throw "zipalign failed" }

Write-Host "==> apksigner"
& $apksigner sign --ks $keystore --ks-pass pass:android --ks-key-alias androiddebugkey `
    --key-pass pass:android --v1-signing-enabled true --v2-signing-enabled true `
    --out "app\AquariumClock.apk" "$build\aligned.apk"
if ($LASTEXITCODE -ne 0) { throw "apksigner failed" }

Write-Host "==> verify"
& $apksigner verify --print-certs "app\AquariumClock.apk" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "apksigner verify failed" }

$size = [math]::Round((Get-Item "app\AquariumClock.apk").Length / 1KB, 1)
Write-Host "BUILD OK -> app\AquariumClock.apk ($size KB)"
