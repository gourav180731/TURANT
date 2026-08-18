# Get the latest CAP alert from the database
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -d turant -Atc "SELECT raw_xml FROM alerts ORDER BY received_at DESC LIMIT 1;" | Out-File "$env:TEMP\cap-alert.xml" -Encoding utf8

if ($LASTEXITCODE -eq 0) {
    Write-Host "✓ Latest alert saved to: $env:TEMP\cap-alert.xml" -ForegroundColor Green
    notepad "$env:TEMP\cap-alert.xml"
} else {
    Write-Host "✗ Failed to retrieve alert" -ForegroundColor Red
}
