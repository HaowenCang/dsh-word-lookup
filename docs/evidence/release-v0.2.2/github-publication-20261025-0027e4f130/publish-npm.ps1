[CmdletBinding()]
param([string]$Otp)
$ErrorActionPreference = 'Stop'
$packagePath = Join-Path $PSScriptRoot 'dsh-word-lookup-0.2.2.tgz'
$expectedSha256 = '30b46d3c8dcf356c29b763c62882eb882a363d49ee0afb27201d25e0b2c08b45'
if ((Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedSha256) { throw 'Package SHA-256 mismatch; publication refused.' }

$publishArgs = @('publish', $packagePath, '--access', 'public', '--tag', 'latest', '--registry', 'https://registry.npmjs.org/', '--ignore-scripts')
if ($PSBoundParameters.ContainsKey('Otp')) { $publishArgs += @('--otp', $Otp) }
& npm @publishArgs
if ($LASTEXITCODE -ne 0) { throw ('npm publish failed with exit code ' + $LASTEXITCODE) }
