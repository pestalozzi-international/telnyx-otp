from setuptools import setup, find_packages

with open("requirements.txt") as f:
	install_requires = [line.strip() for line in f if line.strip()]

setup(
	name="telnyx_otp",
	version="0.1.0",
	description="Receives inbound SMS (Telnyx) and email (Mailgun) webhooks, both relayed via n8n, and displays them in a live per-account inbox with used/expired tracking",
	author="Pestalozzi International",
	author_email="you@example.com",
	packages=find_packages(),
	zip_safe=False,
	include_package_data=True,
	install_requires=install_requires,
)
