import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";
import PublicCertificate from "./components/PublicCertificate";
import { certificateLink } from "./lib/public-certificate";

const link = certificateLink(location.pathname);
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><PublicCertificate link={link} /></React.StrictMode>,
);
