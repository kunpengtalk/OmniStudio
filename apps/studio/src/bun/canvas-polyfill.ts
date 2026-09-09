import {
  DOMMatrix,
  DOMPoint,
  DOMRect,
  ImageData,
  Path2D,
} from "@napi-rs/canvas";

Object.assign(globalThis, { Path2D, DOMMatrix, DOMPoint, DOMRect, ImageData });
