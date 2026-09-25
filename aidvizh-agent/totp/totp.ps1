$secret = $env:TOTP_SECRET
if ([string]::IsNullOrWhiteSpace($secret)) {
    $secure = Read-Host -Prompt 'base32 secret' -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $secret = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

$compact = ($secret -replace '\s', '').ToUpperInvariant()
$alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
$buffer = 0
$bits = 0
$keyBytes = New-Object System.Collections.Generic.List[byte]

foreach ($char in $compact.ToCharArray()) {
    $index = $alphabet.IndexOf($char)
    if ($index -lt 0) { throw "invalid base32 character: $char" }
    $buffer = ($buffer -shl 5) -bor $index
    $bits += 5
    if ($bits -ge 8) {
        $bits -= 8
        $keyBytes.Add([byte](($buffer -shr $bits) -band 0xFF))
    }
}

$unix = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$value = [long][math]::Floor($unix / 30)
$message = New-Object byte[] 8
for ($i = 7; $i -ge 0; $i--) {
    $message[$i] = [byte]($value -band 0xFF)
    $value = $value -shr 8
}

$hmac = New-Object System.Security.Cryptography.HMACSHA1
$hmac.Key = $keyBytes.ToArray()
$hash = $hmac.ComputeHash($message)

$offset = $hash[19] -band 0x0F
$code = ((($hash[$offset] -band 0x7F) -shl 24) -bor ($hash[$offset + 1] -shl 16) -bor ($hash[$offset + 2] -shl 8) -bor $hash[$offset + 3]) % 1000000
$left = 30 - ($unix % 30)
Write-Output ("{0:D6}  ({1}s left)" -f $code, $left)
