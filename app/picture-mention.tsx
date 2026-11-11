/** The hidden token gives the thumbnail its place in the line and keeps the textarea caret aligned. */
export function PictureMention({ token, src }: { token: string; src: string }) {
  return (
    <span className="picture-mention" title={token.slice(1)}>
      <span aria-hidden="true">{token}</span>
      <img src={src} alt={token.slice(1)} draggable={false} />
    </span>
  );
}
