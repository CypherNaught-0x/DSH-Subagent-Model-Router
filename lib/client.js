window.__ModuleLoader__.load({
  id: 'dsh-subagent-model-router',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const h = React.createElement
    const SETTINGS_NAMESPACE = 'subagent-model-router'
    const SETTINGS_ROUTE = '/dsh-subagent-model-router/settings'

    const styles = {
      section: { maxWidth: 820, display: 'flex', flexDirection: 'column', gap: 16, color: 'var(--dsw-alias-label-primary)' },
      heading: { margin: 0, fontSize: 18, lineHeight: '26px' },
      intro: { margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 14, lineHeight: '22px' },
      tip: { margin: 0, padding: '10px 12px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, color: 'var(--dsw-alias-label-secondary)', fontSize: 13, lineHeight: '20px' },
      code: { color: 'var(--dsw-alias-label-primary)', fontFamily: 'monospace', fontWeight: 600 },
      panel: { display: 'flex', flexDirection: 'column', gap: 12, padding: 16, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12 },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 },
      field: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 },
      label: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' },
      input: { boxSizing: 'border-box', width: '100%', minHeight: 36, padding: '7px 10px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, background: 'transparent', color: 'var(--dsw-alias-label-primary)', font: 'inherit' },
      textarea: { boxSizing: 'border-box', width: '100%', minHeight: 76, resize: 'vertical', padding: '8px 10px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, background: 'transparent', color: 'var(--dsw-alias-label-primary)', font: 'inherit' },
      rowHead: { display: 'flex', alignItems: 'center', gap: 8 },
      rowTitle: { margin: 0, fontSize: 15, flex: 1 },
      separator: { display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 },
      separatorTitle: { margin: 0, fontSize: 15, fontWeight: 600 },
      separatorLine: { flex: 1, borderTop: '1px solid var(--dsw-alias-border-l2)' },
      actions: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      button: { minHeight: 34, padding: '0 13px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 17, background: 'transparent', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer', font: 'inherit' },
      primaryButton: { minHeight: 36, padding: '0 16px', border: 0, borderRadius: 18, background: 'var(--dsw-alias-button-primary-fill)', color: 'var(--dsw-alias-label-primary-foreground)', cursor: 'pointer', font: 'inherit' },
      dangerButton: { minHeight: 32, padding: '0 11px', border: '1px solid var(--dsw-alias-state-error-primary)', borderRadius: 16, background: 'transparent', color: 'var(--dsw-alias-state-error-primary)', cursor: 'pointer', font: 'inherit' },
      error: { margin: 0, color: 'var(--dsw-alias-state-error-primary)', fontSize: 13 },
      success: { margin: 0, color: 'var(--dsw-alias-state-success-primary)', fontSize: 13 },
      notice: { margin: 0, color: 'var(--dsw-alias-state-warn-label)', fontSize: 13 },
      checkbox: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 },
      modelChipWrap: { display: 'inline-flex', minWidth: 0, maxWidth: 156, flex: 'none' },
      modelChip: { boxSizing: 'border-box', display: 'inline-block', minWidth: 0, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: '1px 7px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 999, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-secondary)', fontSize: 11, lineHeight: '18px', verticalAlign: 'middle' },
      catalogRoot: { position: 'relative' },
      catalogTrigger: { minHeight: 28, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 5px', border: 0, borderRadius: 6, background: 'transparent', color: 'var(--dsw-alias-label-tertiary)', cursor: 'pointer', font: 'inherit', fontSize: 12 },
      catalogMenu: { zIndex: 100, boxSizing: 'border-box', position: 'absolute', top: 'calc(100% + 5px)', left: 0, display: 'flex', flexDirection: 'column', width: 336, maxWidth: 'min(400px, calc(100vw - 32px))', maxHeight: 'min(560px, calc(100vh - 140px))', overflow: 'auto', padding: 4, borderRadius: 12, background: 'var(--dsw-specific-menu)', boxShadow: 'var(--dsw-shadow-lv3)' },
      catalogNode: { minWidth: 0 },
      catalogRow: { boxSizing: 'border-box', display: 'flex', alignItems: 'flex-start', gap: 8, width: '100%', minHeight: 50, padding: '7px 8px', border: 0, borderRadius: 8, background: 'transparent', color: 'var(--dsw-alias-label-primary)', textAlign: 'left', cursor: 'pointer', font: 'inherit', fontSize: 13, lineHeight: '18px' },
      catalogDisclosure: { flex: 'none', width: 18, minHeight: 24, padding: 0, border: 0, background: 'transparent', color: 'var(--dsw-alias-label-tertiary)', cursor: 'pointer' },
      catalogDisclosureSpace: { flex: 'none', width: 18 },
      catalogDot: { flex: 'none', width: 7, height: 7, marginTop: 6, borderRadius: 999, background: 'var(--dsw-alias-label-dimmed)' },
      catalogDotRunning: { background: 'var(--dsw-alias-state-success-primary)' },
      catalogContent: { display: 'flex', flex: 1, flexDirection: 'column', minWidth: 0 },
      catalogPrimary: { display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 },
      catalogLabel: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 510 },
      catalogSummary: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 },
      catalogChildren: { marginLeft: 17, paddingLeft: 4, borderLeft: '1px solid var(--dsw-alias-border-l2)' },
      catalogNotice: { padding: '10px 12px', color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 },
      catalogError: { padding: '10px 12px', color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 },
    }

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    function modelRoute(summary) {
      const route = summary?.projectionValues?.subagentModelRoute
      return route === null || route === undefined ? undefined : route
    }

    function ModelChip({ route }) {
      const label = `${route.provider}/${route.model}`
      return h('span', {
        style: styles.modelChipWrap,
        title: label,
        'aria-label': label,
      }, h('span', { style: styles.modelChip }, route.model))
    }

    function SubagentModelChip({ useSession, useProjection }) {
      const subagent = useSession((snapshot) => snapshot.subagent)
      const route = useProjection('subagentModelRoute')
      if (subagent === null || subagent === undefined || route === null || route === undefined) return null
      return h(ModelChip, { route })
    }

    function descendantStats(summaries, parentSessionId) {
      const childrenByParent = new Map()
      for (const summary of Object.values(summaries)) {
        if (summary.origin !== 'subagent' || summary.parentId === undefined) continue
        const children = childrenByParent.get(summary.parentId) ?? []
        children.push(summary)
        childrenByParent.set(summary.parentId, children)
      }
      let count = 0
      let runningCount = 0
      const seen = new Set()
      const visit = (id) => {
        for (const child of childrenByParent.get(id) ?? []) {
          if (seen.has(child.id)) continue
          seen.add(child.id)
          count += 1
          if (child.running) runningCount += 1
          visit(child.id)
        }
      }
      visit(parentSessionId)
      return { count, runningCount }
    }

    function diagnosticReason(entry, t) {
      if (entry.reason === 'corrupt') return t('diagnostic.corrupt')
      if (entry.reason === 'unsupported') return t('diagnostic.unsupported')
      return t('diagnostic.unavailable')
    }

    function tokenTotal(usage) {
      return usage === undefined
        ? undefined
        : usage.uncachedInputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
    }

    function formatTokens(value) {
      if (value < 1000) return String(value)
      const scaled = value < 1000000 ? value / 1000 : value / 1000000
      const suffix = value < 1000000 ? 'K' : 'M'
      return `${scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10}${suffix}`
    }

    function activityDuration(summary, activity, now) {
      const timing = summary?.projectionValues?.subagentTiming
      if (timing === undefined) return undefined
      if (timing.active === undefined) return timing.settledMs
      const end = activity === 'running' ? now : timing.active.through
      return timing.settledMs + Math.max(0, end - timing.active.since)
    }

    function splitDuration(ms) {
      const totalSeconds = Math.floor(Math.max(0, ms) / 1000)
      const totalMinutes = Math.floor(totalSeconds / 60)
      const totalHours = Math.floor(totalMinutes / 60)
      return {
        seconds: totalSeconds % 60,
        minutes: totalMinutes % 60,
        hours: totalHours % 24,
        days: Math.floor(totalHours / 24),
        totalMinutes,
        totalHours,
      }
    }

    function formatDuration(ms, t) {
      const { seconds, minutes, hours, days, totalMinutes, totalHours } = splitDuration(ms)
      if (days >= 365) {
        const years = Math.floor(days / 365)
        const months = Math.floor((days % 365) / 30)
        return months === 0 ? t('duration.years', { years }) : t('duration.yearsMonths', { years, months })
      }
      if (days >= 30) {
        const months = Math.floor(days / 30)
        const remainingDays = days % 30
        return remainingDays === 0 ? t('duration.months', { months }) : t('duration.monthsDays', { months, days: remainingDays })
      }
      if (days > 0) return hours === 0 ? t('duration.days', { days }) : t('duration.daysHours', { days, hours })
      if (totalHours > 0) return t('duration.hours', {
        hours: totalHours,
        minutes: String(minutes).padStart(2, '0'),
        seconds: String(seconds).padStart(2, '0'),
      })
      if (totalMinutes > 0) return t('duration.minutes', {
        minutes: totalMinutes,
        seconds: String(seconds).padStart(2, '0'),
      })
      return t('duration.seconds', { seconds })
    }

    function formatExactDuration(ms, t) {
      const { seconds, minutes, hours, days } = splitDuration(ms)
      return days === 0 ? formatDuration(ms, t) : t('duration.exactDays', {
        days,
        hours: String(hours).padStart(2, '0'),
        minutes: String(minutes).padStart(2, '0'),
        seconds: String(seconds).padStart(2, '0'),
      })
    }

    function treeItems(root) {
      return root === null ? [] : Array.from(root.querySelectorAll('[role="treeitem"]:not([aria-disabled="true"])'))
    }

    function CatalogLoadingRows({ parentSessionId, summaries, level, t }) {
      const children = Object.values(summaries).filter((summary) => summary.origin === 'subagent' && summary.parentId === parentSessionId)
      if (children.length === 0) return h('div', { style: styles.catalogNotice }, t('loading.label'))
      return h(React.Fragment, null, ...children.map((summary) => h('div', { key: summary.id, style: styles.catalogNode },
        h('div', {
          role: 'treeitem',
          'aria-disabled': true,
          'aria-level': level,
          'aria-label': t('loading.aria'),
          style: { ...styles.catalogRow, cursor: 'default', color: 'var(--dsw-alias-label-dimmed)' },
        },
        h('span', { style: styles.catalogDisclosureSpace }),
        h('span', { style: styles.catalogDot }),
        h('span', { style: styles.catalogContent }, h('span', { style: styles.catalogLabel }, t('loading.label')))),
      )))
    }

    function CatalogRows({ parentSessionId, catalog, catalogs, summaries, expanded, level, now, sessions, closeCatalog, toggleBranch, t }) {
      const rows = []
      if (catalog.state === 'loading' && catalog.entries.length === 0) {
        rows.push(h(CatalogLoadingRows, { key: `${parentSessionId}:loading`, parentSessionId, summaries, level, t }))
      }
      if (catalog.state === 'error') {
        rows.push(h('div', { key: `${parentSessionId}:error`, style: styles.catalogError },
          h('span', null, catalog.error?.message ?? t('load.error')),
          h('button', {
            type: 'button',
            style: { ...styles.button, minHeight: 28, marginLeft: 8 },
            onClick: () => sessions.refreshSubagents(parentSessionId),
          }, t('retry')),
        ))
      }
      const reserveDisclosure = catalog.entries.some((entry) => entry.kind === 'child' && entry.hasChildren)
      for (const entry of catalog.entries) {
        if (entry.kind === 'diagnostic') {
          const reason = diagnosticReason(entry, t)
          rows.push(h('div', { key: entry.id, style: styles.catalogNode },
            h('div', {
              role: 'treeitem',
              'aria-disabled': true,
              'aria-level': level,
              'aria-label': `${entry.id} ${reason}`,
              title: reason,
              style: { ...styles.catalogRow, cursor: 'not-allowed', color: 'var(--dsw-alias-label-dimmed)' },
            },
            reserveDisclosure ? h('span', { style: styles.catalogDisclosureSpace }) : null,
            h('span', { style: styles.catalogDot }),
            h('span', { style: styles.catalogContent },
              h('span', { style: styles.catalogLabel }, entry.id),
              h('span', { style: styles.catalogSummary }, reason),
            )),
          ))
          continue
        }
        const childCatalog = catalogs[entry.id]
        const isExpanded = expanded.has(entry.id)
        const knownLeaf = !entry.hasChildren
        const summary = summaries[entry.id]
        const route = modelRoute(summary)
        const label = entry.label ?? entry.id
        const secondary = [
          summary?.title,
          entry.mode === 'one-shot' ? t('mode.oneShot') : t('mode.continuable'),
          entry.activity === 'running' ? t('activity.running') : t('activity.inactive'),
        ].filter((value) => value !== undefined).join(' · ')
        const totalTokens = tokenTotal(summary?.projectionValues?.tokenUsage)
        const durationMs = activityDuration(summary, entry.activity, now)
        const tokenMetric = totalTokens === undefined ? undefined : `${formatTokens(totalTokens)} tok`
        const durationMetric = durationMs === undefined ? undefined : {
          compact: formatDuration(durationMs, t),
          exact: formatExactDuration(durationMs, t),
        }
        const metrics = [tokenMetric, durationMetric?.exact].filter((value) => value !== undefined).join(' · ')
        const open = () => {
          sessions.openSubagent({ parentSessionId, childSessionId: entry.id, mode: entry.mode })
          closeCatalog()
        }
        const toggle = (event) => {
          event.preventDefault()
          event.stopPropagation()
          toggleBranch(entry.id)
        }
        rows.push(h('div', { key: entry.id, style: styles.catalogNode },
          h('div', {
            role: 'treeitem',
            tabIndex: 0,
            'aria-level': level,
            'aria-label': [label, secondary, metrics, route === undefined ? '' : `${route.provider}/${route.model}`].filter((value) => value !== '').join(' '),
            ...(knownLeaf ? {} : { 'aria-expanded': isExpanded }),
            style: styles.catalogRow,
            onClick: open,
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                event.stopPropagation()
                open()
              } else if ((event.key === 'ArrowRight' && !knownLeaf && !isExpanded) || (event.key === 'ArrowLeft' && isExpanded)) {
                toggle(event)
              }
            },
          },
          knownLeaf
            ? reserveDisclosure ? h('span', { style: styles.catalogDisclosureSpace }) : null
            : h('button', {
                type: 'button',
                tabIndex: -1,
                style: styles.catalogDisclosure,
                'aria-label': t(isExpanded ? 'branch.collapse' : 'branch.expand', { label }),
                onClick: toggle,
              }, isExpanded ? '▾' : '▸'),
          h('span', { style: { ...styles.catalogDot, ...(entry.activity === 'running' ? styles.catalogDotRunning : {}) } }),
          h('span', { style: styles.catalogContent },
            h('span', { style: styles.catalogPrimary },
              h('span', { style: styles.catalogLabel }, label),
              route === undefined ? null : h(ModelChip, { route }),
            ),
            h('span', { style: styles.catalogSummary }, secondary),
          ),
          metrics === '' ? null : h('span', { style: { flex: 'none', color: 'var(--dsw-alias-label-tertiary)', fontSize: 11 } },
            tokenMetric === undefined ? null : h('span', null, tokenMetric),
            tokenMetric !== undefined && durationMetric !== undefined ? ' · ' : null,
            durationMetric === undefined ? null : h('span', {
              title: t('duration.exactTitle', { duration: durationMetric.exact }),
            }, durationMetric.compact),
          )),
          isExpanded && !knownLeaf ? h('div', { role: 'group', style: styles.catalogChildren },
            childCatalog === undefined
              ? h(CatalogLoadingRows, { parentSessionId: entry.id, summaries, level: level + 1, t })
              : h(CatalogRows, {
                  parentSessionId: entry.id,
                  catalog: childCatalog,
                  catalogs,
                  summaries,
                  expanded,
                  level: level + 1,
                  now,
                  sessions,
                  closeCatalog,
                  toggleBranch,
                  t,
                }),
          ) : null,
        ))
      }
      return h(React.Fragment, null, ...rows)
    }

    function SubagentCatalogAction({ sessionId, useSessions, sessions, t }) {
      const catalogs = useSessions((state) => state.subagentsByParent)
      const summaries = useSessions((state) => state.byId)
      const catalog = catalogs[sessionId]
      const [open, setOpen] = React.useState(false)
      const [expanded, setExpanded] = React.useState(() => new Set())
      const [now, setNow] = React.useState(() => Date.now())
      const rootRef = React.useRef(null)
      const triggerRef = React.useRef(null)
      const observedCatalogs = React.useRef(new Set())
      const setCatalogOpenRef = React.useRef((parentSessionId, next) => sessions.setSubagentCatalogOpen(parentSessionId, next))
      setCatalogOpenRef.current = (parentSessionId, next) => sessions.setSubagentCatalogOpen(parentSessionId, next)
      const healthy = catalog?.entries.filter((entry) => entry.kind === 'child') ?? []
      const stats = React.useMemo(() => descendantStats(summaries, sessionId), [summaries, sessionId])
      const descendantCount = Math.max(healthy.length, stats.count)
      const totalCountKey = descendantCount === 1 ? 'count.total.one' : 'count.total.other'
      const runningCountKey = stats.runningCount === 1 ? 'count.running.one' : 'count.running.other'
      const presentedCatalog = stats.count > 0 && (catalog === undefined || (catalog.state === 'ready' && catalog.entries.length === 0))
        ? { entries: [], parentAvailable: catalog?.parentAvailable ?? false, state: 'loading', error: null }
        : catalog
      const observeCatalog = (parentSessionId, next) => {
        if (next) observedCatalogs.current.add(parentSessionId)
        else observedCatalogs.current.delete(parentSessionId)
        sessions.setSubagentCatalogOpen(parentSessionId, next)
      }
      const closeAllCatalogs = () => {
        for (const parentSessionId of observedCatalogs.current) sessions.setSubagentCatalogOpen(parentSessionId, false)
        observedCatalogs.current.clear()
        setExpanded(new Set())
      }
      const changeOpen = (next, restoreFocus = false) => {
        setOpen(next)
        if (next) {
          setNow(Date.now())
          observeCatalog(sessionId, true)
        } else closeAllCatalogs()
        if (restoreFocus && typeof queueMicrotask === 'function') queueMicrotask(() => triggerRef.current?.focus())
      }
      const closeBranch = (root) => {
        const closing = new Set()
        const visit = (parentSessionId) => {
          if (closing.has(parentSessionId) || !expanded.has(parentSessionId)) return
          closing.add(parentSessionId)
          const branch = catalogs[parentSessionId]
          for (const entry of branch?.entries ?? []) if (entry.kind === 'child') visit(entry.id)
        }
        visit(root)
        for (const parentSessionId of closing) observeCatalog(parentSessionId, false)
        setExpanded(new Set([...expanded].filter((id) => !closing.has(id))))
      }
      const toggleBranch = (childSessionId) => {
        if (expanded.has(childSessionId)) {
          closeBranch(childSessionId)
          return
        }
        setExpanded(new Set(expanded).add(childSessionId))
        observeCatalog(childSessionId, true)
      }
      React.useEffect(() => {
        if (!open || typeof document === 'undefined') return undefined
        const closeOutside = (event) => {
          if (typeof Node !== 'undefined' && event.target instanceof Node && !rootRef.current?.contains(event.target)) changeOpen(false)
        }
        document.addEventListener('pointerdown', closeOutside)
        return () => document.removeEventListener('pointerdown', closeOutside)
      }, [open])
      React.useEffect(() => {
        if (!open || stats.runningCount === 0 || typeof setInterval !== 'function') return undefined
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
      }, [open, stats.runningCount])
      React.useEffect(() => () => {
        for (const parentSessionId of observedCatalogs.current) setCatalogOpenRef.current(parentSessionId, false)
        observedCatalogs.current.clear()
      }, [])
      const visible = presentedCatalog !== undefined && (presentedCatalog.state === 'error' || presentedCatalog.entries.length > 0 || descendantCount > 0)
      React.useEffect(() => {
        if (!visible && open) {
          setOpen(false)
          closeAllCatalogs()
        }
      }, [visible, open])
      if (!visible) return null
      const focusAt = (index) => {
        const items = treeItems(rootRef.current)
        if (items.length === 0) return
        items[(index + items.length) % items.length]?.focus()
      }
      const navigate = (event) => {
        const items = treeItems(rootRef.current)
        const index = typeof document === 'undefined' ? -1 : items.indexOf(document.activeElement)
        if (event.key === 'Escape') {
          event.preventDefault()
          changeOpen(false, true)
        } else if (event.key === 'Home') {
          event.preventDefault()
          focusAt(0)
        } else if (event.key === 'End') {
          event.preventDefault()
          focusAt(items.length - 1)
        } else if (event.key === 'ArrowDown') {
          event.preventDefault()
          focusAt(index + 1)
        } else if (event.key === 'ArrowUp') {
          event.preventDefault()
          focusAt(index < 0 ? items.length - 1 : index - 1)
        }
      }
      return h('div', { ref: rootRef, style: styles.catalogRoot, onKeyDown: navigate },
        h('button', {
          ref: triggerRef,
          type: 'button',
          style: styles.catalogTrigger,
          'aria-haspopup': 'tree',
          'aria-expanded': open,
          'aria-label': t(stats.runningCount > 0 ? runningCountKey : totalCountKey, {
            count: stats.runningCount > 0 ? stats.runningCount : descendantCount,
          }),
          onClick: () => changeOpen(!open),
          onKeyDown: (event) => {
            if (event.key !== 'ArrowDown') return
            event.preventDefault()
            if (!open) changeOpen(true)
            if (typeof queueMicrotask === 'function') queueMicrotask(() => focusAt(0))
          },
        },
        stats.runningCount > 0 ? h('span', { style: { ...styles.catalogDot, ...styles.catalogDotRunning, marginTop: 0 } }) : null,
        t(totalCountKey, { count: descendantCount }),
        h('span', { 'aria-hidden': true }, open ? '▴' : '▾')),
        open ? h('div', { role: 'tree', 'aria-label': t('tree.aria'), style: styles.catalogMenu },
          h(CatalogRows, {
            parentSessionId: sessionId,
            catalog: presentedCatalog,
            catalogs,
            summaries,
            expanded,
            level: 1,
            now,
            sessions,
            closeCatalog: () => changeOpen(false),
            toggleBranch,
            t,
          }),
        ) : null,
      )
    }

    function emptyModel() {
      return {
        alias: '',
        provider: '',
        model: '',
        displayName: '',
        tags: '',
        description: '',
        maxTokens: '',
      }
    }

    function draftFromValue(value) {
      const source = typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
      const models = Array.isArray(source.models) ? source.models : []
      return {
        subagentProvider: typeof source.subagentProvider === 'string' ? source.subagentProvider : 'spawn',
        maxDepth: Number.isSafeInteger(source.maxDepth) ? String(source.maxDepth) : '3',
        enableRunInBackground: source.enableRunInBackground !== false,
        models: models.map((entry) => ({
          alias: typeof entry.alias === 'string' ? entry.alias : '',
          provider: typeof entry.provider === 'string' ? entry.provider : '',
          model: typeof entry.model === 'string' ? entry.model : '',
          displayName: typeof entry.displayName === 'string' ? entry.displayName : '',
          tags: Array.isArray(entry.tags) ? entry.tags.join(', ') : '',
          description: typeof entry.description === 'string' ? entry.description : '',
          maxTokens: Number.isSafeInteger(entry.maxTokens) ? String(entry.maxTokens) : '',
        })),
      }
    }

    function parseTags(value) {
      return [...new Set(value.split(',').map((tag) => tag.trim()).filter(Boolean))]
    }

    function validateDraft(draft) {
      if (draft.subagentProvider.trim().length === 0) return 'Subagent provider is required.'
      const maxDepth = Number(draft.maxDepth)
      if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) return 'Maximum depth must be a non-negative integer.'
      const aliases = new Set()
      for (let index = 0; index < draft.models.length; index += 1) {
        const row = draft.models[index]
        const label = `Model ${index + 1}`
        if (!/^[a-z0-9][a-z0-9_-]*$/.test(row.alias)) return `${label}: alias must use lowercase letters, numbers, underscores, or hyphens.`
        if (aliases.has(row.alias)) return `${label}: alias “${row.alias}” is duplicated.`
        aliases.add(row.alias)
        if (row.provider.trim().length === 0) return `${label}: provider is required.`
        if (row.model.trim().length === 0) return `${label}: model id is required.`
        if (row.description.trim().length === 0) return `${label}: usage description is required.`
        const tags = parseTags(row.tags)
        if (tags.some((tag) => !/^[a-z0-9][a-z0-9-]*$/.test(tag))) return `${label}: tags must be lowercase kebab-case.`
        if (row.maxTokens.trim().length > 0) {
          const maxTokens = Number(row.maxTokens)
          if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) return `${label}: max tokens must be a positive integer.`
        }
      }
      return undefined
    }

    function settingsFromDraft(draft) {
      return {
        subagentProvider: draft.subagentProvider.trim(),
        maxDepth: Number(draft.maxDepth),
        enableRunInBackground: draft.enableRunInBackground,
        models: draft.models.map((row) => ({
          alias: row.alias.trim(),
          provider: row.provider.trim(),
          model: row.model.trim(),
          ...(row.displayName.trim().length === 0 ? {} : { displayName: row.displayName.trim() }),
          tags: parseTags(row.tags),
          description: row.description.trim(),
          ...(row.maxTokens.trim().length === 0 ? {} : { maxTokens: Number(row.maxTokens) }),
        })),
      }
    }

    async function requestSettings(method, body) {
      const response = await fetch(SETTINGS_ROUTE, {
        method,
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      let value
      try {
        value = await response.json()
      } catch {
        throw new Error(`Subagent model settings returned HTTP ${response.status}.`)
      }
      if (!response.ok) {
        throw new Error(typeof value.error === 'string' ? value.error : `Subagent model settings returned HTTP ${response.status}.`)
      }
      return value
    }

    function Field(props) {
      return h('label', { style: styles.field },
        h('span', { style: styles.label }, props.label),
        props.children,
      )
    }

    function textInput(value, onChange, options = {}) {
      return h('input', {
        style: styles.input,
        value,
        onChange: (event) => onChange(event.target.value),
        ...options,
      })
    }

    function createSettingsSection(ctx, connection, remote) {
      return function SubagentModelsSettings() {
        const [snapshot, setSnapshot] = React.useState({
          status: 'loading',
          writable: false,
          descriptor: undefined,
          error: null,
          saved: false,
        })
        const [draft, setDraft] = React.useState(() => draftFromValue({}))

        React.useEffect(() => {
          let active = true
          let generation = 0
          const load = async () => {
            const ownGeneration = ++generation
            setSnapshot((previous) => ({ ...previous, status: 'loading', error: null, saved: false }))
            try {
              const value = await requestSettings('GET')
              const descriptor = value.descriptor
              if (descriptor === undefined) throw new Error('Subagent model settings endpoint returned no descriptor.')
              if (!active || ownGeneration !== generation) return
              setDraft(draftFromValue(descriptor.value))
              setSnapshot({ status: 'ready', writable: value.writable, descriptor, error: null, saved: false })
            } catch (error) {
              if (!active || ownGeneration !== generation) return
              setSnapshot((previous) => ({ ...previous, status: 'error', error: messageOf(error), saved: false }))
            }
          }
          const offRemote = remote.$on('settings/document-updated', (namespace) => {
            if (namespace === SETTINGS_NAMESPACE) load()
          })
          const offConnection = ctx.on('connection/reset', load)
          load()
          return () => {
            active = false
            offRemote()
            offConnection()
          }
        }, [])

        const updateGlobal = (field, value) => {
          setDraft((previous) => ({ ...previous, [field]: value }))
          setSnapshot((previous) => ({ ...previous, saved: false }))
        }
        const updateModel = (index, field, value) => {
          setDraft((previous) => ({
            ...previous,
            models: previous.models.map((row, rowIndex) => rowIndex === index ? { ...row, [field]: value } : row),
          }))
          setSnapshot((previous) => ({ ...previous, saved: false }))
        }
        const addModel = () => {
          setDraft((previous) => ({ ...previous, models: [...previous.models, emptyModel()] }))
          setSnapshot((previous) => ({ ...previous, saved: false }))
        }
        const removeModel = (index) => {
          setDraft((previous) => ({ ...previous, models: previous.models.filter((_row, rowIndex) => rowIndex !== index) }))
          setSnapshot((previous) => ({ ...previous, saved: false }))
        }
        const save = async () => {
          const failure = validateDraft(draft)
          if (failure !== undefined) {
            setSnapshot((previous) => ({ ...previous, status: 'error', error: failure, saved: false }))
            return
          }
          if (!snapshot.writable || snapshot.descriptor === undefined) return
          setSnapshot((previous) => ({ ...previous, status: 'saving', error: null, saved: false }))
          try {
            const value = await requestSettings('PUT', {
              section: settingsFromDraft(draft),
              expectedRevision: snapshot.descriptor.revision,
            })
            const descriptor = value.descriptor
            setDraft(draftFromValue(descriptor.value))
            setSnapshot((previous) => ({ ...previous, status: 'ready', writable: value.writable, descriptor, error: null, saved: true }))
          } catch (error) {
            setSnapshot((previous) => ({ ...previous, status: 'error', error: messageOf(error), saved: false }))
          }
        }

        const modelCards = draft.models.map((row, index) => h('div', { key: `${index}:${row.alias}`, style: styles.panel },
          h('div', { style: styles.rowHead },
            h('h3', { style: styles.rowTitle }, row.displayName.trim() || row.alias.trim() || `Model ${index + 1}`),
            h('button', { type: 'button', style: styles.dangerButton, onClick: () => removeModel(index), disabled: !snapshot.writable }, 'Remove'),
          ),
          h('div', { style: styles.grid },
            h(Field, { label: 'Alias' }, textInput(row.alias, (value) => updateModel(index, 'alias', value), { placeholder: 'fast' })),
            h(Field, { label: 'Display name' }, textInput(row.displayName, (value) => updateModel(index, 'displayName', value), { placeholder: 'Fast model' })),
            h(Field, { label: 'Provider route' }, textInput(row.provider, (value) => updateModel(index, 'provider', value), { placeholder: 'provider-id' })),
            h(Field, { label: 'Model ID' }, textInput(row.model, (value) => updateModel(index, 'model', value), { placeholder: 'model-id' })),
            h(Field, { label: 'Tags (comma-separated)' }, textInput(row.tags, (value) => updateModel(index, 'tags', value), { placeholder: 'fast, routine' })),
            h(Field, { label: 'Max tokens (optional)' }, textInput(row.maxTokens, (value) => updateModel(index, 'maxTokens', value), { type: 'number', min: 1, step: 1, placeholder: 'Provider default' })),
          ),
          h(Field, { label: 'When to use this model' },
            h('textarea', {
              style: styles.textarea,
              value: row.description,
              onChange: (event) => updateModel(index, 'description', event.target.value),
              placeholder: 'Use for quick, well-scoped tasks where low latency matters.',
            }),
          ),
        ))

        return h('section', { style: styles.section },
          h('h2', { style: styles.heading }, 'Subagent Models'),
          h('p', { style: styles.intro }, 'Choose the model routes exposed to AI agents for delegated work. Changes are stored under subagent-model-router in settings.yaml and apply live.'),
          h('p', { style: styles.tip },
            'Prefer guided setup? In chat, run ',
            h('code', { style: styles.code }, '/model-subagent-setup'),
            ' to discover available routes and generate distinct routing descriptions.',
          ),
          h('div', { style: styles.panel },
            h('h3', { style: styles.rowTitle }, 'Delegation defaults'),
            h('div', { style: styles.grid },
              h(Field, { label: 'Subagent provider' }, textInput(draft.subagentProvider, (value) => updateGlobal('subagentProvider', value), { placeholder: 'spawn' })),
              h(Field, { label: 'Maximum depth' }, textInput(draft.maxDepth, (value) => updateGlobal('maxDepth', value), { type: 'number', min: 0, step: 1 })),
            ),
            h('label', { style: styles.checkbox },
              h('input', {
                type: 'checkbox',
                checked: draft.enableRunInBackground,
                onChange: (event) => updateGlobal('enableRunInBackground', event.target.checked),
              }),
              'Enable durable background subagents',
            ),
          ),
          h('div', { style: styles.separator },
            h('h3', { style: styles.separatorTitle }, 'Models'),
            h('span', { style: styles.separatorLine, 'aria-hidden': true }),
          ),
          ...modelCards,
          h('div', { style: styles.actions },
            h('button', { type: 'button', style: styles.button, onClick: addModel, disabled: !snapshot.writable }, 'Add model'),
            h('button', { type: 'button', style: styles.primaryButton, onClick: save, disabled: !snapshot.writable || snapshot.status === 'saving' }, snapshot.status === 'saving' ? 'Saving…' : 'Save changes'),
          ),
          !snapshot.writable && snapshot.status === 'ready' ? h('p', { style: styles.notice }, 'This settings provider is read-only.') : null,
          snapshot.error !== null ? h('p', { style: styles.error }, snapshot.error) : null,
          snapshot.saved ? h('p', { style: styles.success }, 'Saved. The subagent tool has been updated live.') : null,
          snapshot.status === 'loading' ? h('p', { style: styles.intro }, 'Loading settings…') : null,
        )
      }
    }

    const inject = ['slots', 'connection', 'remote', 'sessions']

    function apply(ctx) {
      const slots = ctx.get('slots')
      const connection = ctx.get('connection')
      const remote = ctx.get('remote')
      const sessions = ctx.get('sessions')
      if (slots === undefined || connection === undefined || remote === undefined || sessions === undefined) return
      // Both header cells are shadow registrations: the host's own entries sit
      // at the default priority 0, so ours claim priority -1 (lowest renders)
      // and fall back to the host entry if this component ever abdicates.
      // `order` still governs display position, independent of priority.
      slots.inject('conversation.session.header.actions', () => slots.register({
        name: 'conversation.session.header.actions',
        id: 'subagent-model',
        order: -10,
        priority: -1,
      }, SubagentModelChip))
      slots.inject('conversation.session.header.actions', () => slots.register({
        name: 'conversation.session.header.actions',
        id: 'subagent-catalog',
        order: 10,
        priority: -1,
        locale: 'subagent',
      }, (props) => h(SubagentCatalogAction, { ...props, sessions })))
      const Section = createSettingsSection(ctx, connection, remote)
      slots.inject('settings.section', () => slots.register({
        name: 'settings.section',
        id: 'subagent-model-router',
        order: 25,
        label: 'Subagent Models',
      }, Section))
    }

    module.exports.ModelChip = ModelChip
    module.exports.SubagentCatalogAction = SubagentCatalogAction
    module.exports.SubagentModelChip = SubagentModelChip
    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  },
})
