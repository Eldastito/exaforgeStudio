import type { ImgHTMLAttributes } from "react";
import zappFlowMarkUrl from "./zappflow-mark.svg";

type ZappFlowMarkProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "alt"> & {
  /** Tamanho em pixels. Pode ser sobrescrito via className/CSS. */
  size?: number;
};

/**
 * Marca oficial ZappFlow: use este único componente em sidebar,
 * login, landing e demais pontos de branding.
 */
export function ZappFlowMark({
  size = 32,
  width,
  height,
  style,
  ...props
}: ZappFlowMarkProps) {
  return (
    <img
      src={zappFlowMarkUrl}
      alt="ZappFlow"
      width={width ?? size}
      height={height ?? size}
      draggable={false}
      style={{ display: "block", objectFit: "contain", ...style }}
      {...props}
    />
  );
}
