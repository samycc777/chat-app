interface Props {
  name: string;
  color: string;
  size?: 'normal' | 'small';
  online?: boolean;
}

export default function Avatar({ name, color, size = 'normal', online }: Props) {
  const initials = name
    .split(' ')
    .map(w => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  return (
    <div className={`avatar ${size}`} style={{ backgroundColor: color }}>
      {initials}
      {online && <div className="online-dot" />}
    </div>
  );
}
