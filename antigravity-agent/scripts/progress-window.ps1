param(
  [Parameter(Mandatory=$true)][Guid]$TaskId,
  [Parameter(Mandatory=$true)][string]$TaskPath
)
$ErrorActionPreference = 'Stop'
$taskFilePath = [IO.Path]::GetFullPath($TaskPath)
if ([IO.Path]::GetFileName($taskFilePath) -ne "$TaskId.json") { throw 'Task ID does not match the task record.' }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ProgressWindowVisibility {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int mode);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
}
'@
[Windows.Forms.Application]::EnableVisualStyles()

$script:record = $null
$script:lastStamp = ''
$script:resultText = ''
$script:visibleChars = 24000
$script:readProblem = $false
$terminalStates = @('completed','failed','cancelled','timed_out','interrupted','needs_input')
$stateLabels = @{ starting='正在启动'; running='正在工作'; resuming='正在接收补充指令'; cancelling='正在取消'; completed='已完成'; failed='失败'; cancelled='已取消'; timed_out='已超时'; interrupted='已中断'; needs_input='需要处理权限或输入' }
$stageLabels = @{ task='任务'; message='补充指令'; user_input='任务输入'; agent_response='Agent 响应'; tool='工具'; step='执行步骤' }
$eventLabels = @{ RUNNING='运行中'; ACTIVE='正在执行'; DONE='完成'; WAITING='等待'; CANCELED='取消'; SUCCESS='完成'; ERROR='出错' }

$form = New-Object Windows.Forms.Form
$form.Name = 'AntigravityProgress'
$form.Text = "Antigravity 任务进度 - $TaskId"
$form.StartPosition = 'CenterScreen'
$form.Size = New-Object Drawing.Size(800,680)
$form.MinimumSize = New-Object Drawing.Size(650,520)
$form.Font = New-Object Drawing.Font('Microsoft YaHei UI',10)
$form.AutoScaleMode = 'Dpi'
$form.BackColor = [Drawing.Color]::FromArgb(248,249,251)
$layout = New-Object Windows.Forms.TableLayoutPanel
$layout.Dock = 'Fill'
$layout.Padding = New-Object Windows.Forms.Padding(18)
$layout.ColumnCount = 1
$layout.RowCount = 7
foreach ($height in @(36,30,26,148,32)) { [void]$layout.RowStyles.Add((New-Object Windows.Forms.RowStyle('Absolute',$height))) }
[void]$layout.RowStyles.Add((New-Object Windows.Forms.RowStyle('Percent',100)))
[void]$layout.RowStyles.Add((New-Object Windows.Forms.RowStyle('Absolute',64)))
$form.Controls.Add($layout)

function New-Label([string]$name,[int]$row) {
  $label = New-Object Windows.Forms.Label
  $label.Name = $name
  $label.Dock = 'Fill'
  $label.TextAlign = 'MiddleLeft'
  $layout.Controls.Add($label,0,$row)
  return $label
}
$status = New-Label 'TaskStatus' 0
$status.Font = New-Object Drawing.Font('Microsoft YaHei UI',15,[Drawing.FontStyle]::Bold)
$status.Text = '正在读取任务…'
$elapsed = New-Label 'ElapsedTime' 1
$activity = New-Label 'LastActivity' 2
$activity.ForeColor = [Drawing.Color]::DimGray
$steps = New-Object Windows.Forms.ListView
$steps.Name = 'RecentSteps'
$steps.Dock = 'Fill'
$steps.View = 'Details'
$steps.FullRowSelect = $true
$steps.HeaderStyle = 'Nonclickable'
[void]$steps.Columns.Add('时间',90)
[void]$steps.Columns.Add('执行内容',440)
[void]$steps.Columns.Add('状态',110)
$layout.Controls.Add($steps,0,3)
$notice = New-Label 'TaskNotice' 4
$notice.ForeColor = [Drawing.Color]::DimGray
$notice.Text = '窗口每秒检查更新；关闭窗口不会取消任务。'
$output = New-Object Windows.Forms.TextBox
$output.Name = 'TaskResult'
$output.Dock = 'Fill'
$output.Multiline = $true
$output.ReadOnly = $true
$output.ScrollBars = 'Vertical'
$output.BackColor = [Drawing.Color]::White
$output.Text = '任务完成后，结果将在这里显示。'
$layout.Controls.Add($output,0,5)
$footer = New-Object Windows.Forms.FlowLayoutPanel
$footer.Dock = 'Fill'
$footer.WrapContents = $true
$layout.Controls.Add($footer,0,6)
function New-Button([string]$text,[string]$name) {
  $button = New-Object Windows.Forms.Button
  $button.Name = $name
  $button.Text = $text
  $button.AutoSize = $true
  $button.Margin = New-Object Windows.Forms.Padding(0,10,10,0)
  $footer.Controls.Add($button)
  return $button
}
$copy = New-Button '复制完整结果' 'CopyResult'
$copy.Enabled = $false
$more = New-Button '显示更多结果' 'ShowMore'
$more.Visible = $false
$copyId = New-Button '复制任务编号' 'CopyTaskId'
$pin = New-Button '置顶' 'PinWindow'
$copyId.Add_Click({ [Windows.Forms.Clipboard]::SetText($TaskId.ToString()) })
$copy.Add_Click({ if ($script:resultText) { [Windows.Forms.Clipboard]::SetText($script:resultText) } })
$pin.Add_Click({ $form.TopMost = -not $form.TopMost; $pin.Text = $(if ($form.TopMost) { '取消置顶' } else { '置顶' }) })
function Update-Result {
  $count = [Math]::Min($script:visibleChars,$script:resultText.Length)
  $output.Text = $(if ($count -gt 0) { $script:resultText.Substring(0,$count) } else { '任务已结束，没有返回正文。' })
  $more.Visible = $count -lt $script:resultText.Length
  $copy.Enabled = $script:resultText.Length -gt 0
}
$more.Add_Click({ $script:visibleChars += 24000; Update-Result })
function Format-Time($value) {
  if (-not $value) { return '' }
  return ([DateTimeOffset]::Parse([string]$value)).ToLocalTime().ToString('HH:mm:ss')
}
function Update-Window {
  try {
    $file = Get-Item -LiteralPath $taskFilePath
    $stamp = "$($file.LastWriteTimeUtc.Ticks):$($file.Length)"
    if ($stamp -ne $script:lastStamp) {
      $nextRecord = [IO.File]::ReadAllText($taskFilePath,[Text.Encoding]::UTF8) | ConvertFrom-Json
      if ($nextRecord.id -ne $TaskId.ToString()) { throw 'Unexpected task record ID.' }
      $script:record = $nextRecord
      $script:lastStamp = $stamp
      $script:readProblem = $false
      $status.Text = $(if ($stateLabels.ContainsKey([string]$nextRecord.status)) { $stateLabels[[string]$nextRecord.status] } else { [string]$nextRecord.status })
      $activity.Text = '最近活动：' + (Format-Time $nextRecord.lastActivityAt)
      $steps.BeginUpdate()
      $steps.Items.Clear()
      foreach ($step in @($nextRecord.progressEvents)) {
        if (-not $step) { continue }
        $label = $(if ($stageLabels.ContainsKey([string]$step.stage)) { $stageLabels[[string]$step.stage] } else { [string]$step.stage })
        if ($step.tool) { $label += ' · ' + [string]$step.tool }
        $state = $(if ($eventLabels.ContainsKey([string]$step.state)) { $eventLabels[[string]$step.state] } else { [string]$step.state })
        $item = New-Object Windows.Forms.ListViewItem((Format-Time $step.at))
        [void]$item.SubItems.Add($label)
        [void]$item.SubItems.Add($state)
        [void]$steps.Items.Add($item)
      }
      $steps.EndUpdate()
      if ($steps.Items.Count -gt 0) { $steps.Items[$steps.Items.Count-1].EnsureVisible() }
      if ($terminalStates -contains [string]$nextRecord.status) {
        $response = $nextRecord.resultEvent.result.response
        $script:resultText = $(if ($null -eq $response) { '' } elseif ($response -is [string]) { $response } else { $response | ConvertTo-Json -Depth 100 })
        Update-Result
        $notice.Text = $(if ($nextRecord.error) { [string]$nextRecord.error } else { '结果已保存。Chat 可通过 get_task 读取；关闭窗口不会删除结果。' })
        $notice.ForeColor = $(if ($nextRecord.error) { [Drawing.Color]::Firebrick } else { [Drawing.Color]::DimGray })
      } else {
        $pending = @($nextRecord.messages | Where-Object { $_.status -in @('queued','interrupt_requested','dispatching') }).Count
        $notice.Text = $(if ($pending -gt 0) { "有 $pending 条补充指令等待处理；关闭窗口不会取消任务。" } else { '窗口每秒检查更新；关闭窗口不会取消任务。' })
        $notice.ForeColor = [Drawing.Color]::DimGray
      }
    }
    if ($script:record) {
      $started = $script:record.startedAt
      if (-not $started) { $started = $script:record.createdAt }
      $end = [DateTimeOffset]::Now
      if (($terminalStates -contains [string]$script:record.status) -and $script:record.finishedAt) { $end = [DateTimeOffset]::Parse([string]$script:record.finishedAt) }
      $seconds = [Math]::Max(0,[Math]::Floor(($end - [DateTimeOffset]::Parse([string]$started)).TotalSeconds))
      $elapsed.Text = '已运行 {0}小时{1}分{2:00}秒' -f [Math]::Floor($seconds/3600),([Math]::Floor($seconds/60)%60),($seconds%60)
    }
  } catch {
    if (-not $script:readProblem) { [Console]::Error.WriteLine($_.Exception.Message) }
    $script:readProblem = $true
    $notice.Text = '暂时无法读取进度，正在重试。Chat 可通过 get_task 查询任务。'
    $notice.ForeColor = [Drawing.Color]::Firebrick
  }
}
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 1000
$timer.Add_Tick({ Update-Window })
$form.Add_Shown({
  # Override the hidden-console startup flag for this form only.
  [void][ProgressWindowVisibility]::ShowWindow($form.Handle,5)
  Update-Window
  $timer.Start()
  if ([ProgressWindowVisibility]::IsWindowVisible($form.Handle)) { [Console]::Out.WriteLine('READY'); [Console]::Out.Flush() }
})
$form.Add_FormClosed({ $timer.Stop(); $timer.Dispose() })
try { [void]$form.ShowDialog() } finally { $form.Dispose() }
