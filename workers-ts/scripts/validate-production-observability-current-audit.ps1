# Project one fixed TEST-003B response. No caller may serialize the parsed HTTP
# body: reject unknown fields and copy only bounded aggregate values below.
function Assert-AuditKeys {
    param([object]$Value,[string[]]$Keys)
    if ($null -eq $Value -or $Value -isnot [pscustomobject]) { throw 'Aggregate object missing.' }
    $actual = @($Value.PSObject.Properties.Name | Sort-Object -CaseSensitive)
    $expected = @($Keys | Sort-Object -CaseSensitive)
    if (($actual -join '|') -cne ($expected -join '|')) { throw 'Aggregate fields differ.' }
}
function Assert-AuditBool {
    param([object]$Value)
    if ($Value -isnot [bool]) { throw 'Aggregate boolean invalid.' }
    return [bool]$Value
}
function Convert-AuditUnsigned {
    param([object]$Value,[bool]$Nullable=$false,[long]$Maximum=[long]::MaxValue)
    if ($null -eq $Value -and $Nullable) { return $null }
    if ($Value -is [bool] -or $Value -isnot [string] -and
        $Value -isnot [int] -and $Value -isnot [long]) { throw 'Aggregate count type invalid.' }
    $literal = [string]$Value
    if ($literal -cnotmatch '^(0|[1-9][0-9]{0,18})$') { throw 'Aggregate count format invalid.' }
    $parsed = 0L
    if (-not [long]::TryParse($literal,[ref]$parsed) -or $parsed -gt $Maximum) {
        throw 'Aggregate count range invalid.'
    }
    return $parsed.ToString([Globalization.CultureInfo]::InvariantCulture)
}
function Convert-AuditMilliseconds {
    param([object]$Value,[bool]$Nullable=$false)
    if ($null -eq $Value -and $Nullable) { return $null }
    if ($Value -is [bool] -or $Value -isnot [int] -and $Value -isnot [long] -and
        $Value -isnot [double] -and $Value -isnot [decimal]) {
        throw 'Aggregate duration type invalid.'
    }
    $number = [double]$Value
    if ([double]::IsNaN($number) -or [double]::IsInfinity($number) -or
        $number -lt 0 -or $number -gt 1000000000000000) {
        throw 'Aggregate duration range invalid.'
    }
    return $number
}
function Assert-AuditTimeString {
    param([object]$Value,[bool]$Nullable=$false)
    if ($null -eq $Value -and $Nullable) { return $false }
    if ($Value -isnot [string] -or $Value.Length -gt 64 -or
        $Value -cnotmatch '^20[0-9]{2}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2}') {
        throw 'Aggregate timestamp invalid.'
    }
    return $true
}
function Convert-ObservabilityAggregate {
    param([object]$Raw)
    Assert-AuditKeys $Raw @('generatedAt','scope','ready','settings','extensions',
        'statementStatistics','databaseStats','activity','workflowStatus',
        'workflowAttention','relationStats','safety')
    if ($Raw.scope -cne 'production-observability-db-aggregate') { throw 'Aggregate scope invalid.' }
    $ready = Assert-AuditBool $Raw.ready
    if ($Raw.generatedAt -isnot [string] -or
        $Raw.generatedAt -cnotmatch '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$') {
        throw 'Aggregate sample time invalid.'
    }
    $sampleTime = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParseExact($Raw.generatedAt,
        'yyyy-MM-ddTHH:mm:ss.fffZ',[Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::AssumeUniversal,[ref]$sampleTime) -or
        [Math]::Abs(([DateTimeOffset]::UtcNow - $sampleTime).TotalMinutes) -gt 5) {
        throw 'Aggregate sample time out of bounds.'
    }

    Assert-AuditKeys $Raw.settings @('server_version','track_activities','track_counts',
        'track_io_timing','compute_query_id','log_min_duration_statement',
        'statement_timeout','idle_in_transaction_session_timeout')
    if ($Raw.settings.server_version -isnot [string] -or
        $Raw.settings.server_version.Length -gt 128 -or
        $Raw.settings.server_version -cnotmatch '^16\.[0-9]{1,2}(\s.*)?$' -or
        @('on','off') -cnotcontains $Raw.settings.track_activities -or
        @('on','off') -cnotcontains $Raw.settings.track_counts -or
        @('on','off') -cnotcontains $Raw.settings.track_io_timing -or
        @('auto','on','off','regress') -cnotcontains $Raw.settings.compute_query_id -or
        $Raw.settings.log_min_duration_statement -isnot [string] -or
        $Raw.settings.log_min_duration_statement -cnotmatch '^-?[0-9]{1,9}(ms|s|min|h|d)?$' -or
        $Raw.settings.statement_timeout -cne '5s' -or
        $Raw.settings.idle_in_transaction_session_timeout -cne '7s') {
        throw 'Aggregate PostgreSQL settings differ.'
    }
    $settings = [ordered]@{ pgMajor = 16;
        trackActivities = $Raw.settings.track_activities;
        trackCounts = $Raw.settings.track_counts;
        trackIoTiming = $Raw.settings.track_io_timing;
        computeQueryId = $Raw.settings.compute_query_id;
        statementTimeout = '5s'; idleTransactionTimeout = '7s' }

    if ($Raw.extensions -isnot [array] -or $Raw.extensions.Count -gt 2) {
        throw 'Aggregate extensions invalid.'
    }
    $extensions = @($Raw.extensions)
    if (@($extensions | Select-Object -Unique).Count -ne $extensions.Count -or
        @($extensions | Where-Object { @('pg_stat_statements','pg_stat_monitor') -cnotcontains $_ }).Count) {
        throw 'Aggregate extension name invalid.'
    }

    Assert-AuditKeys $Raw.statementStatistics @('available','authorized','aggregate','queryTextReturned')
    $statementAvailable = Assert-AuditBool $Raw.statementStatistics.available
    $statementAuthorized = Assert-AuditBool $Raw.statementStatistics.authorized
    if ((Assert-AuditBool $Raw.statementStatistics.queryTextReturned) -ne $false) {
        throw 'Statement query text boundary failed.'
    }
    $statementAggregate = $null
    if ($statementAvailable -and $statementAuthorized) {
        Assert-AuditKeys $Raw.statementStatistics.aggregate @('statements','calls','rows',
            'total_exec_ms','maximum_exec_ms')
        $statementAggregate = [ordered]@{
            statements = Convert-AuditUnsigned $Raw.statementStatistics.aggregate.statements $false 1000000000
            calls = Convert-AuditUnsigned $Raw.statementStatistics.aggregate.calls
            rows = Convert-AuditUnsigned $Raw.statementStatistics.aggregate.rows
            totalExecMs = Convert-AuditMilliseconds $Raw.statementStatistics.aggregate.total_exec_ms
            maximumExecMs = Convert-AuditMilliseconds $Raw.statementStatistics.aggregate.maximum_exec_ms
        }
    } elseif ($null -ne $Raw.statementStatistics.aggregate) {
        throw 'Unavailable statement aggregate was exposed.'
    }

    Assert-AuditKeys $Raw.databaseStats @('numbackends','xact_commit','xact_rollback',
        'blks_read','blks_hit','temp_files','temp_bytes','deadlocks','checksum_failures',
        'session_time_ms','active_time_ms','idle_in_transaction_time_ms','stats_reset')
    $databaseStats = [ordered]@{
        backends = Convert-AuditUnsigned $Raw.databaseStats.numbackends $false 1000000
        commits = Convert-AuditUnsigned $Raw.databaseStats.xact_commit
        rollbacks = Convert-AuditUnsigned $Raw.databaseStats.xact_rollback
        blocksRead = Convert-AuditUnsigned $Raw.databaseStats.blks_read
        blocksHit = Convert-AuditUnsigned $Raw.databaseStats.blks_hit
        temporaryFiles = Convert-AuditUnsigned $Raw.databaseStats.temp_files
        temporaryBytes = Convert-AuditUnsigned $Raw.databaseStats.temp_bytes
        deadlocks = Convert-AuditUnsigned $Raw.databaseStats.deadlocks
        checksumFailures = Convert-AuditUnsigned $Raw.databaseStats.checksum_failures $true
        sessionTimeMs = Convert-AuditMilliseconds $Raw.databaseStats.session_time_ms $true
        activeTimeMs = Convert-AuditMilliseconds $Raw.databaseStats.active_time_ms $true
        idleTransactionTimeMs = Convert-AuditMilliseconds $Raw.databaseStats.idle_in_transaction_time_ms $true
        statsResetRecorded = Assert-AuditTimeString $Raw.databaseStats.stats_reset $true
    }

    $activity = $null
    if ($null -ne $Raw.activity) {
        if ($Raw.activity -isnot [array] -or $Raw.activity.Count -gt 64) {
            throw 'Aggregate activity groups invalid.'
        }
        $activity = @($Raw.activity | ForEach-Object {
            Assert-AuditKeys $_ @('state','wait_event_type','sessions',
                'transactions_over_1s','transactions_over_5s')
            if (@('active','idle','idle in transaction','idle in transaction (aborted)',
                'fastpath function call','unknown') -cnotcontains $_.state -or
                @('none','Activity','BufferPin','Client','Extension','IO','IPC','Lock',
                  'LWLock','Timeout','InjectionPoint') -cnotcontains $_.wait_event_type) {
                throw 'Aggregate activity category invalid.'
            }
            [ordered]@{ state = $_.state; waitEventType = $_.wait_event_type;
                sessions = Convert-AuditUnsigned $_.sessions $false 1000000;
                over1s = Convert-AuditUnsigned $_.transactions_over_1s $false 1000000;
                over5s = Convert-AuditUnsigned $_.transactions_over_5s $false 1000000 }
        })
    }

    if ($Raw.workflowStatus -isnot [array] -or $Raw.workflowStatus.Count -gt 40) {
        throw 'Aggregate workflow groups invalid.'
    }
    $allowedStatus = @{
        print = @('PENDING','ENQUEUING','ENQUEUED','PROCESSING','RETRYABLE','SENT',
            'UNKNOWN','DEAD','CLOSED','OTHER')
        waybill = @('PENDING','ENQUEUING','ENQUEUED','PROCESSING','RETRYABLE','SENT',
            'UNKNOWN','DEAD','CLOSED','OTHER')
        refund_payment = @('CREATED','REQUESTING','PROCESSING','SUCCESS','CLOSED',
            'ABNORMAL','FAILED','UNKNOWN','OTHER')
        queue_dead_letter = @('OPEN','REPLAYING','REPLAYED','RESOLVED','OTHER')
    }
    $seenWorkflow = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $workflowStatus = @($Raw.workflowStatus | ForEach-Object {
        Assert-AuditKeys $_ @('workflow','status','rows')
        if ($_.workflow -isnot [string] -or -not $allowedStatus.ContainsKey($_.workflow) -or
            $_.status -isnot [string] -or $allowedStatus[$_.workflow] -cnotcontains $_.status -or
            -not $seenWorkflow.Add("$($_.workflow)|$($_.status)")) {
            throw 'Aggregate workflow label invalid.'
        }
        [ordered]@{ workflow = $_.workflow; status = $_.status;
            rows = Convert-AuditUnsigned $_.rows $false 1000000000 }
    })

    Assert-AuditKeys $Raw.workflowAttention @('print_attention','waybill_attention',
        'refund_attention','dead_letter_attention','oldest_unknown_refund_seconds')
    $workflowAttention = [ordered]@{
        print = Convert-AuditUnsigned $Raw.workflowAttention.print_attention $false 1000000000
        waybill = Convert-AuditUnsigned $Raw.workflowAttention.waybill_attention $false 1000000000
        refund = Convert-AuditUnsigned $Raw.workflowAttention.refund_attention $false 1000000000
        deadLetter = Convert-AuditUnsigned $Raw.workflowAttention.dead_letter_attention $false 1000000000
        oldestUnknownRefundSeconds = Convert-AuditUnsigned $Raw.workflowAttention.oldest_unknown_refund_seconds
    }

    if ($Raw.relationStats -isnot [array] -or $Raw.relationStats.Count -gt 7) {
        throw 'Aggregate relation statistics invalid.'
    }
    $allowedRelations = @('order_print_job','order_waybill_job',
        'store_order_refund_payment','system_queue_dead_letter','store_order',
        'store_product','user')
    $seenRelations = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $relationStats = @($Raw.relationStats | ForEach-Object {
        Assert-AuditKeys $_ @('relname','seq_scan','idx_scan','n_live_tup',
            'n_dead_tup','last_analyze','last_autoanalyze')
        if ($_.relname -isnot [string] -or $allowedRelations -cnotcontains $_.relname -or
            -not $seenRelations.Add($_.relname)) { throw 'Aggregate relation name invalid.' }
        [ordered]@{
            relation = $_.relname
            sequentialScans = Convert-AuditUnsigned $_.seq_scan $true
            indexScans = Convert-AuditUnsigned $_.idx_scan $true
            estimatedLiveRows = Convert-AuditUnsigned $_.n_live_tup $true
            estimatedDeadRows = Convert-AuditUnsigned $_.n_dead_tup $true
            analyzeRecorded = Assert-AuditTimeString $_.last_analyze $true
            autoanalyzeRecorded = Assert-AuditTimeString $_.last_autoanalyze $true
        }
    })
    foreach ($name in @('order_print_job','order_waybill_job',
        'store_order_refund_payment','system_queue_dead_letter')) {
        if (-not $seenRelations.Contains($name)) { throw 'Required relation statistics missing.' }
    }

    Assert-AuditKeys $Raw.safety @('identityVerified','transactionReadOnly','repeatableRead',
        'queryTextReturned','businessValuesReturned')
    if ((Assert-AuditBool $Raw.safety.identityVerified) -ne $true -or
        (Assert-AuditBool $Raw.safety.transactionReadOnly) -ne $true -or
        (Assert-AuditBool $Raw.safety.repeatableRead) -ne $true -or
        (Assert-AuditBool $Raw.safety.queryTextReturned) -ne $false -or
        (Assert-AuditBool $Raw.safety.businessValuesReturned) -ne $false) {
        throw 'Aggregate safety proof invalid.'
    }
    $expectedReady = $statementAuthorized -and $settings.trackCounts -ceq 'on' -and
        $settings.trackActivities -ceq 'on' -and $null -ne $activity
    if ($ready -ne $expectedReady) { throw 'Aggregate readiness inconsistent.' }
    $limitations = @()
    if (-not $statementAuthorized) { $limitations += 'monitoring_privilege_unavailable' }
    if ($settings.trackCounts -cne 'on') { $limitations += 'track_counts_disabled' }
    if ($settings.trackActivities -cne 'on') { $limitations += 'track_activities_disabled' }
    if ($null -eq $activity -and $settings.trackActivities -ceq 'on') {
        $limitations += 'activity_snapshot_incomplete'
    }
    if (-not $statementAvailable) { $limitations += 'statement_extension_unavailable' }

    return [ordered]@{
        generatedAt = $Raw.generatedAt
        scope = 'production-observability-db-aggregate'
        ready = $ready
        settings = $settings
        extensions = $extensions
        statementStatistics = [ordered]@{ available = $statementAvailable;
            authorized = $statementAuthorized; aggregate = $statementAggregate;
            queryTextReturned = $false }
        databaseStats = $databaseStats
        activity = $activity
        workflowStatus = $workflowStatus
        workflowAttention = $workflowAttention
        relationStats = $relationStats
        safety = [ordered]@{ identityVerified = $true; transactionReadOnly = $true;
            repeatableRead = $true; queryTextReturned = $false;
            businessValuesReturned = $false }
        limitations = $limitations
    }
}
