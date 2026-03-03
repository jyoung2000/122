import React from 'react';

export default function GlassPanel({
  children,
  style = {},
  hover = false,
  active = false,
  className = '',
  as: Tag = 'div',
  ...props
}) {
  const [hovered, setHovered] = React.useState(false);

  const baseStyle = {
    background: 'var(--glass-bg)',
    backdropFilter: 'blur(var(--glass-blur)) saturate(180%)',
    WebkitBackdropFilter: 'blur(var(--glass-blur)) saturate(180%)',
    border: `1px solid ${active ? 'var(--accent-cyan)' : 'var(--glass-border)'}`,
    borderRadius: 'var(--radius-md)',
    transition: 'all 0.25s var(--ease-spring)',
    ...(hover && hovered ? {
      background: 'var(--glass-hover)',
      transform: 'translateY(-1px)',
      boxShadow: 'var(--shadow-md)',
    } : {}),
    ...(active ? {
      background: 'var(--accent-cyan-dim)',
    } : {}),
    ...style,
  };

  return (
    <Tag
      className={className}
      style={baseStyle}
      onMouseEnter={hover ? () => setHovered(true) : undefined}
      onMouseLeave={hover ? () => setHovered(false) : undefined}
      {...props}
    >
      {children}
    </Tag>
  );
}
