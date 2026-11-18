import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";
import PublicCertificate from "./components/PublicCertificate";
import { validShareToken } from "../shared/media-certificate";

const candidate = /^\/verify\/([^/]+)\/?$/.exec(location.pathname)?.[1] ?? "";
const token = validShareToken(candidate) ? candidate : "";
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><PublicCertificate token={token} /></React.StrictMode>,
);
