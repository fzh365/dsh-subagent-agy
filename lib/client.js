/**
 * Browser half: a full-permission switch on the dsh-subagent-agy package
 * detail page, above the included-plugin rows. The switch writes the provider
 * entry's volatile `dangerouslySkipPermissions` field through the shared
 * settings form, so the host profile patch remains the single source of truth.
 */
window.__ModuleLoader__.load({
  id: 'dsh-subagent-agy',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')

    const NS = 'subagent-agy'
    const PACKAGE_NAME = 'dsh-subagent-agy'
    const ROW_ID = 'subagent-agy'
    const FIELD = 'dangerouslySkipPermissions'

    const en = {
      title: 'Full permissions',
      description: 'Allow agy to run shell commands and other tools during headless runs.',
      warning: 'This grants agy arbitrary command execution. Enable it only in a trusted workspace.',
      loading: 'Loading…',
      unavailable: 'This plugin is not loaded, so its permissions cannot be changed right now.',
      readOnly: 'This deployment stores settings read-only.',
      saveFailed: 'The host did not accept the change. The switch was restored.',
      on: 'On',
      off: 'Off',
    }
    const zh = {
      title: '完全权限',
      description: '允许 agy 在无头运行中执行 shell 命令和其他工具。',
      warning: '开启后 agy 可以执行任意命令。请只在可信工作区启用。',
      loading: '加载中…',
      unavailable: '该插件当前未加载，暂时无法修改权限。',
      readOnly: '本部署的设置为只读。',
      saveFailed: '宿主没有接受这次修改，开关已恢复。',
      on: '打开',
      off: '关闭',
    }

    /** Bundle config entries render only the full page, never the summary. */
    function AgyPermissionsSection(props = {}) {
      if (props.view !== 'page') return null
      // Resolve the form before any hook runs (this component has none), so
      // the card's hooks always operate on a real form. A missing form — the
      // settings namespace absent, the row disabled mid-flight — renders
      // nothing instead of crashing the whole detail page.
      const form = props.configForms?.get?.(ROW_ID)
      if (!form) return null
      return React.createElement(AgyPermissionsCard, { ...props, form })
    }

    /** The card: copy on the left, state label and slider on the right. */
    function AgyPermissionsCard(props) {
      const { form, t } = props
      const snapshot = React.useSyncExternalStore(
        React.useCallback((notify) => form.subscribe(notify), [form]),
        React.useCallback(() => form.getSnapshot(), [form]),
      )
      const [pending, setPending] = React.useState(false)
      const [failed, setFailed] = React.useState(false)

      const value = snapshot.value ?? {}
      const enabled = value[FIELD] === true
      const writable = snapshot.writable === true
      const ready = snapshot.status === 'ready'
      const disabled = pending || !ready || !writable

      const onToggle = React.useCallback(async () => {
        if (disabled) return
        setPending(true)
        setFailed(false)
        try {
          const accepted = await form.set(FIELD, !enabled)
          if (!accepted) setFailed(true)
        } catch {
          setFailed(true)
        } finally {
          setPending(false)
        }
      }, [disabled, enabled, form])

      const styles = {
        card: {
          border: '0.5px solid var(--dsw-alias-settings-card-stroke, rgba(0,0,0,0.16))',
          borderRadius: 'var(--dsw-radius-xl, 20px)',
          background: 'var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1, #fff))',
          padding: '14px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
        },
        row: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '16px',
          flexWrap: 'wrap',
        },
        copy: {
          display: 'flex',
          flexDirection: 'column',
          gap: '4px',
          minWidth: 0,
          flex: '1 1 240px',
        },
        title: {
          margin: 0,
          fontSize: '14px',
          fontWeight: 600,
          lineHeight: '20px',
          color: 'var(--dsw-alias-label-primary, #1f2328)',
        },
        description: {
          margin: 0,
          fontSize: '12px',
          lineHeight: '18px',
          color: 'var(--dsw-alias-label-tertiary, #8b93a1)',
        },
        warning: {
          margin: 0,
          fontSize: '12px',
          lineHeight: '18px',
          color: 'var(--dsw-alias-state-warn-primary, #b45309)',
        },
        control: {
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          marginLeft: 'auto',
          flexShrink: 0,
        },
        state: {
          fontSize: '12px',
          lineHeight: '18px',
          color: enabled
            ? 'var(--dsw-alias-state-success-primary, #16a34a)'
            : 'var(--dsw-alias-label-tertiary, #8b93a1)',
        },
        track: {
          position: 'relative',
          boxSizing: 'border-box',
          width: '38px',
          height: '22px',
          padding: 0,
          border: `1px solid ${enabled ? 'var(--dsw-alias-button-primary-fill, #0f1115)' : 'var(--dsw-alias-border-l2, #d9dde3)'}`,
          borderRadius: '99px',
          background: enabled
            ? 'var(--dsw-alias-button-primary-fill, #0f1115)'
            : 'var(--dsw-alias-bg-layer-2, #e5e7eb)',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          transition: 'background .15s, border-color .15s',
          flexShrink: 0,
        },
        knob: {
          position: 'absolute',
          top: '2px',
          left: enabled ? '18px' : '2px',
          width: '16px',
          height: '16px',
          borderRadius: '99px',
          background: '#fff',
          boxShadow: '0 1px 2px rgba(0,0,0,.25)',
          transition: 'left .15s',
        },
        error: {
          margin: 0,
          fontSize: '12px',
          lineHeight: '18px',
          color: 'var(--dsw-alias-state-error-primary, #dc2626)',
        },
        muted: {
          margin: 0,
          fontSize: '12px',
          lineHeight: '18px',
          color: 'var(--dsw-alias-label-tertiary, #8b93a1)',
        },
      }

      return React.createElement(
        'div',
        { style: styles.card, 'data-subagent-agy-permissions': true },
        React.createElement(
          'div',
          { style: styles.row },
          React.createElement(
            'div',
            { style: styles.copy },
            React.createElement('h4', { style: styles.title }, t('title')),
            React.createElement('p', { style: styles.description }, t('description')),
            enabled ? React.createElement('p', { style: styles.warning }, t('warning')) : null,
          ),
          React.createElement(
            'div',
            { style: styles.control },
            React.createElement('span', { style: styles.state }, enabled ? t('on') : t('off')),
            React.createElement(
              'button',
              {
                type: 'button',
                role: 'switch',
                'aria-checked': enabled,
                'aria-label': t('title'),
                disabled,
                onClick: onToggle,
                style: styles.track,
              },
              React.createElement('span', { style: styles.knob }),
            ),
          ),
        ),
        snapshot.status === 'loading'
          ? React.createElement('p', { style: styles.muted }, t('loading'))
          : snapshot.status !== 'ready'
            ? React.createElement('p', { style: styles.muted }, t('unavailable'))
            : null,
        ready && !writable ? React.createElement('p', { style: styles.muted }, t('readOnly')) : null,
        failed ? React.createElement('p', { style: styles.error }, t('saveFailed')) : null,
      )
    }

    const inject = ['slots', 'locale', 'configForms']

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'subagent-agy: dictionaries')
      ctx.effect(
        () =>
          ctx.slots.inject('plugins.bundle.config', () =>
            ctx.slots.register(
              {
                name: 'plugins.bundle.config',
                key: PACKAGE_NAME,
                locale: NS,
                inject: () => ({ configForms: ctx.configForms, t }),
              },
              AgyPermissionsSection,
            ),
          ),
        'subagent-agy: bundle permissions card',
      )
    }

    exports.NS = NS
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
