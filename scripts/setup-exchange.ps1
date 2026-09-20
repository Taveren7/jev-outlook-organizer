# Requires an interactive Connect-ExchangeOnline session as an Exchange administrator.
# Preview first; apply scoped mail and category-setting permissions only after review.
# Never grants tenant-wide Entra mail roles or Mail.Send.
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][guid]$TenantId,
    [Parameter(Mandatory)][guid]$AppId,
    [Parameter(Mandatory)][guid]$ServicePrincipalId,
    [Parameter(Mandatory)][guid]$MailboxObjectId,
    [ValidateSet('Mail.Read', 'Mail.ReadWrite', 'MailboxSettings.ReadWrite')][string]$Permission = 'Mail.Read',
    [switch]$Apply
)
$ErrorActionPreference = 'Stop'
$connections = @(Get-ConnectionInformation | Where-Object { $_.State -eq 'Connected' })
if ($connections.Count -ne 1 -or [string]$connections[0].TenantID -ne [string]$TenantId) {
    throw 'Connect to exactly one Exchange tenant matching TenantId before continuing.'
}
$scopeName = "JevOutlook-$($AppId.ToString().Substring(0, 8))-Mailbox"
$role = "Application $Permission"
$assignmentName = "JevOutlook-$($AppId.ToString().Substring(0, 8))-$($Permission.Replace('.', ''))"
$filter = "ExternalDirectoryObjectId -eq '$MailboxObjectId'"
$recipients = @(Get-Recipient -Filter $filter -ResultSize Unlimited)
if ($recipients.Count -ne 1 -or [string]$recipients[0].ExternalDirectoryObjectId -ne [string]$MailboxObjectId) {
    throw 'Proposed scope must resolve to exactly the requested mailbox.'
}
if ([string]$recipients[0].RecipientTypeDetails -notin @('UserMailbox', 'SharedMailbox')) {
    throw 'The selected recipient is not a user or shared mailbox.'
}
Write-Output ([pscustomobject]@{
    Mode = $(if ($Apply) { 'apply' } else { 'preview' })
    Permission = $role
    MatchingRecipients = $recipients.Count
    AppId = $AppId
    ServicePrincipalId = $ServicePrincipalId
    ScopeName = $scopeName
})
if (-not $Apply) { return }

$existingScope = Get-ManagementScope -Identity $scopeName -ErrorAction SilentlyContinue
if ($existingScope) {
    $members = @(Get-Recipient -RecipientPreviewFilter $existingScope.RecipientFilter -ResultSize Unlimited)
    if ($members.Count -ne 1 -or [string]$members[0].ExternalDirectoryObjectId -ne [string]$MailboxObjectId -or $existingScope.Exclusive) {
        throw 'Existing scope differs from the intended single-mailbox scope; no grant made.'
    }
    # Membership alone is insufficient: reject a broader rule that happens to match one mailbox today.
    $normalized = ([string]$existingScope.RecipientFilter).Replace('(', '').Replace(')', '').Trim()
    if ($normalized -ne $filter) { throw 'Existing scope filter differs; manual review required.' }
} elseif ($PSCmdlet.ShouldProcess($scopeName, 'Create a scope matching one mailbox object ID')) {
    $existingScope = New-ManagementScope -Name $scopeName -RecipientRestrictionFilter $filter
}
$principal = Get-ServicePrincipal -Identity $ServicePrincipalId -ErrorAction SilentlyContinue
if ($principal -and [string]$principal.AppId -ne [string]$AppId) { throw 'Service principal app ID mismatch.' }
if (-not $principal -and $PSCmdlet.ShouldProcess($ServicePrincipalId, 'Register the Entra service principal in Exchange')) {
    $principal = New-ServicePrincipal -AppId $AppId -ObjectId $ServicePrincipalId -DisplayName 'Jev Outlook'
}
$assignment = Get-ManagementRoleAssignment -Identity $assignmentName -ErrorAction SilentlyContinue
if ($assignment) {
    if ([string]$assignment.Role -ne $role -or [string]$assignment.CustomResourceScope -ne $scopeName -or [string]$assignment.RoleAssignee -ne [string]$ServicePrincipalId -or [string]$assignment.RoleAssigneeType -ne 'ServicePrincipal') {
        throw 'Existing role assignment differs; manual review required.'
    }
} elseif ($PSCmdlet.ShouldProcess($AppId, "Grant $role limited to the verified mailbox scope")) {
    New-ManagementRoleAssignment -Name $assignmentName -App $ServicePrincipalId -Role $role -CustomResourceScope $scopeName | Out-Null
}
if (-not $WhatIfPreference) {
    $allowed = @(Test-ServicePrincipalAuthorization -Identity $ServicePrincipalId -Resource $MailboxObjectId)
    $read = @($allowed | Where-Object { $_.RoleName -eq $role -and $_.InScope -eq $true })
    if ($read.Count -ne 1) { throw 'Role created but expected mailbox authorization did not verify.' }
    Write-Output ($allowed | Select-Object RoleName, GrantedPermissions, AllowedResourceScope, InScope)
    $other = @(Get-Recipient -Filter "RecipientTypeDetails -eq 'UserMailbox' -and ExternalDirectoryObjectId -ne '$MailboxObjectId'" -ResultSize 1 -WarningAction SilentlyContinue)
    if ($other.Count -eq 1) {
        $denied = @(Test-ServicePrincipalAuthorization -Identity $ServicePrincipalId -Resource $other[0].ExternalDirectoryObjectId)
        if (@($denied | Where-Object { $_.InScope -eq $true }).Count -gt 0) { throw 'Out-of-scope mailbox is unexpectedly authorized.' }
        Write-Output 'A different mailbox is outside the application scope.'
    } else {
        Write-Warning 'No second user mailbox found for the negative scope check.'
    }
    Write-Output 'Exchange RBAC verified. Graph propagation and any independent Entra grants still require verification.'
}
