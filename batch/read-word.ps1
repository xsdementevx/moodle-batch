param([Parameter(Mandatory=$true)][string]$InputPath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$taskWord = $null
$taskDocument = $null
$taskOldUpdateLinks = $null
$taskConfirm = $false
$taskReadOnly = $true
$taskRecent = $false
$taskSaveChanges = 0
try {
    $taskWord = New-Object -ComObject Word.Application
    $taskWord.Visible = $false
    $taskWord.DisplayAlerts = 0
    $taskWord.AutomationSecurity = 3
    $taskOldUpdateLinks = $taskWord.Options.UpdateLinksAtOpen
    $taskWord.Options.UpdateLinksAtOpen = $false
    $taskDocument = $taskWord.Documents.Open([ref]$InputPath, [ref]$taskConfirm, [ref]$taskReadOnly, [ref]$taskRecent)
    [Console]::Write($taskDocument.Content.Text)
} finally {
    if ($null -ne $taskDocument) { $taskDocument.Close([ref]$taskSaveChanges) }
    if ($null -ne $taskWord) {
        if ($null -ne $taskOldUpdateLinks) { $taskWord.Options.UpdateLinksAtOpen = $taskOldUpdateLinks }
        $taskWord.Quit([ref]$taskSaveChanges)
    }
}
