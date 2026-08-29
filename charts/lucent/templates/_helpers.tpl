{{/*
Expand the name of the chart. Truncated to 63 chars (DNS-1123 label limit).
*/}}
{{- define "lucent.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Fully-qualified app name. Stable across templates so a Deployment, Service,
and Ingress can share one resource prefix.
*/}}
{{- define "lucent.fullname" -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if eq .Release.Name $name -}}
{{- $name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" $name .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{/*
Common labels — applied to every resource the chart generates so a single
selector query (`app.kubernetes.io/name=lucent`) returns the whole chart.
*/}}
{{- define "lucent.labels" -}}
app.kubernetes.io/name: {{ include "lucent.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{/*
Selector labels — the subset of `lucent.labels` that uniquely identifies a
resource. Stable across upgrades because we never template the name on a
mutable field.
*/}}
{{- define "lucent.selectorLabels" -}}
app.kubernetes.io/name: {{ include "lucent.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
