{{/*
Common labels. Usage: {{ include "platform-lab.labels" (dict "root" $ "name" "api-gateway") }}
*/}}
{{- define "platform-lab.labels" -}}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/part-of: platform-lab
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
helm.sh/chart: {{ .root.Chart.Name }}-{{ .root.Chart.Version }}
{{- end -}}

{{/*
Selector labels, kept separate from platform-lab.labels because selectors are immutable on update.
*/}}
{{- define "platform-lab.selectorLabels" -}}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/part-of: platform-lab
{{- end -}}

{{/*
Renders container env entries sourced from a pre-existing Secret (never created by this chart).
Usage: {{ include "platform-lab.secretEnv" .Values.orderService.secretEnv }}
Input is a map of ENV_NAME -> {secretName, secretKey}.
*/}}
{{- define "platform-lab.secretEnv" -}}
{{- range $name, $ref := . }}
- name: {{ $name }}
  valueFrom:
    secretKeyRef:
      name: {{ $ref.secretName }}
      key: {{ $ref.secretKey }}
{{- end -}}
{{- end -}}
